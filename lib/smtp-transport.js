'use strict';

// 引入所需模块
const EventEmitter = require('events');
const SmtpConnection = require('./smtp-connection');
const wellKnown = require('./well-known');
const XOAuth2 = require('./xoauth2');
const packageData = require('../package.json');
const { parseConnectionUrl, assign, getLogger, callbackPromise } = require('./shared');
/**
 * 为Nodemailer创建SMTP传输对象./fetch
 *
 * @constructor
 * @param {Object} options 连接选项
 */
class SmtpTransport extends EventEmitter {
    constructor(options) {
        super();

        options = options || {};
        // 如果options是字符串，则将其转换为包含url属性的对象
        if (typeof options === 'string') options = { url: options };

        let urlData;
        let service = options.service;

        // 如果提供了getSocket函数，则使用它
        if (typeof options.getSocket === 'function') this.getSocket = options.getSocket;

        // 如果提供了URL，则解析连接URL
        if (options.url) {
            urlData = parseConnectionUrl(options.url);
            service = service || urlData.service;
        }

        // 合并选项：常规选项、URL选项和知名服务选项
        this.options = assign(
            false, // 创建新对象
            options, // 常规选项
            urlData, // URL选项
            service && wellKnown(service) // 知名服务选项
        );

        // 创建日志记录器
        this.logger = getLogger(this.options, {
            component: this.options.component || 'smtpTransport'
        });

        // 创建临时SMTP连接对象
        let connection = new SmtpConnection(this.options);

        this.name = 'SMTP';
        this.version = packageData.version + '[client:' + connection.version + ']';

        // 如果提供了认证信息，则设置认证
        if (this.options.auth) this.auth = this.getAuth({});
    }

    /**
     * 用于创建代理套接字的占位函数。此方法立即返回而不提供套接字
     *
     * @param {Object} options 连接选项
     * @param {Function} callback 回调函数，用于处理套接字密钥
     */
    getSocket(options, callback) {
        return setImmediate(() => callback(null, false)); // 立即返回空套接字
    }

    /**
     * 获取认证信息
     * @param {Object} authOpts 认证选项
     * @returns {Object|boolean} 认证对象或false
     */
    getAuth(authOpts) {
        if (!authOpts) return this.auth;

        let hasAuth = false;
        let authData = {};

        // 从选项复制认证数据
        if (this.options.auth && typeof this.options.auth === 'object')
            Object.keys(this.options.auth).forEach(key => {
                hasAuth = true;
                authData[key] = this.options.auth[key];
            });

        // 从参数复制认证数据
        if (authOpts && typeof authOpts === 'object')
            Object.keys(authOpts).forEach(key => {
                hasAuth = true;
                authData[key] = authOpts[key];
            });

        if (!hasAuth) return false;

        // 根据认证类型处理不同的认证方式
        switch ((authData.type || '').toString().toUpperCase()) {
            case 'OAUTH2': {
                if (!authData.service && !authData.user) return false;

                let oauth2 = new XOAuth2(authData, this.logger);
                oauth2.provisionCallback = (this.mailer && this.mailer.get('oauth2_provision_cb')) || oauth2.provisionCallback;
                oauth2.on('token', token => this.mailer.emit('token', token));
                oauth2.on('error', err => this.emit('error', err));
                return {
                    type: 'OAUTH2',
                    user: authData.user,
                    oauth2,
                    method: 'XOAUTH2'
                };
            }
            default:
                // 默认使用LOGIN认证方式
                return {
                    type: (authData.type || '').toString().toUpperCase() || 'LOGIN',
                    user: authData.user,
                    credentials: {
                        user: authData.user || '',
                        pass: authData.pass,
                        options: authData.options
                    },
                    method: (authData.method || '').trim().toUpperCase() || this.options.authMethod || false
                };
        }
    }

    /**
     * 使用选定的设置发送电子邮件
     *
     * @param {Object} mail 邮件对象
     * @param {Function} callback 回调函数
     */
    send(mail, callback) {
        this.getSocket(this.options, (err, socketOptions) => {
            if (err) return callback(err);

            let returned = false;
            let options = this.options;

            // 如果使用代理套接字，则记录日志并更新选项
            if (socketOptions && socketOptions.connection) {
                this.logger.info(
                    {
                        tnx: 'proxy',
                        remoteAddress: socketOptions.connection.remoteAddress,
                        remotePort: socketOptions.connection.remotePort,
                        destHost: options.host || '',
                        destPort: options.port || '',
                        action: 'connected'
                    },
                    '使用从 %s:%s 到 %s:%s 的代理套接字',
                    socketOptions.connection.remoteAddress,
                    socketOptions.connection.remotePort,
                    options.host || '',
                    options.port || ''
                );

                // 只有在需要修改时才复制选项
                options = assign(false, options);
                Object.keys(socketOptions).forEach(key => {
                    options[key] = socketOptions[key];
                });
            }

            let connection = new SmtpConnection(options);

            // 处理连接错误
            connection.once('error', err => {
                if (returned) return;
                returned = true;

                connection.close();
                return callback(err);
            });

            // 处理连接结束
            connection.once('end', () => {
                if (returned) return;

                let timer = setTimeout(() => {
                    if (returned) return;
                    returned = true;

                    // 仍未返回，这意味着发生了意外的连接关闭
                    let err = new Error('意外的套接字关闭');
                    // 如果连接正在升级，则将错误代码设置为ETLS
                    if (connection && connection._socket && connection._socket.upgrading) err.code = 'ETLS';

                    callback(err);
                }, 1000);

                try {
                    timer.unref();
                } catch (E) { }
            });

            // 发送消息的内部函数
            let sendMessage = () => {
                let envelope = mail.message.getEnvelope();
                let messageId = mail.message.messageId();

                let recipients = [].concat(envelope.to || []);
                if (recipients.length > 3) recipients.push('...以及另外 ' + recipients.splice(2).length + ' 个收件人');

                if (mail.data.dsn) envelope.dsn = mail.data.dsn;

                this.logger.info(
                    {
                        tnx: 'send',
                        messageId
                    },
                    '正在发送消息 %s 给 <%s>',
                    messageId,
                    recipients.join(', ')
                );

                // 实际发送消息
                connection.send(envelope, mail.message.createReadStream(), (err, info) => {
                    returned = true;
                    connection.close();
                    if (err) {
                        this.logger.error(
                            {
                                err,
                                tnx: 'send'
                            },
                            '发送 %s 时出错: %s',
                            messageId,
                            err.message
                        );
                        return callback(err);
                    }
                    info.envelope = {
                        from: envelope.from,
                        to: envelope.to
                    };
                    info.messageId = messageId;
                    try {
                        return callback(null, info);
                    } catch (E) {
                        this.logger.error(
                            {
                                err: E,
                                tnx: 'callback'
                            },
                            '处理 %s 的回调时出错: %s',
                            messageId,
                            E.message
                        );
                    }
                });
            };

            // 连接SMTP服务器
            connection.connect(() => {
                if (returned) return;

                let auth = this.getAuth(mail.data.auth);

                // 如果需要且支持认证，则进行登录
                if (auth && (connection.allowsAuth || options.forceAuth)) {
                    connection.login(auth, err => {
                        if (auth && auth !== this.auth && auth.oauth2) auth.oauth2.removeAllListeners();

                        if (returned) return;

                        if (err) {
                            returned = true;
                            connection.close();
                            return callback(err);
                        }

                        sendMessage();
                    });
                }
                else sendMessage();
            });
        });
    }

    /**
     * 验证SMTP配置
     *
     * @param {Function} callback 回调函数
     */
    verify(callback) {
        let promise;

        // 如果没有提供回调，则创建Promise
        if (!callback)
            promise = new Promise((resolve, reject) => {
                callback = callbackPromise(resolve, reject);
            });

        this.getSocket(this.options, (err, socketOptions) => {
            if (err) return callback(err);

            let options = this.options;
            // 如果使用代理套接字，则记录日志并更新选项
            if (socketOptions && socketOptions.connection) {
                this.logger.info(
                    {
                        tnx: 'proxy',
                        remoteAddress: socketOptions.connection.remoteAddress,
                        remotePort: socketOptions.connection.remotePort,
                        destHost: options.host || '',
                        destPort: options.port || '',
                        action: 'connected'
                    },
                    '使用从 %s:%s 到 %s:%s 的代理套接字',
                    socketOptions.connection.remoteAddress,
                    socketOptions.connection.remotePort,
                    options.host || '',
                    options.port || ''
                );

                options = assign(false, options);
                Object.keys(socketOptions).forEach(key => {
                    options[key] = socketOptions[key];
                });
            }

            let connection = new SmtpConnection(options);
            let returned = false;

            // 处理连接错误
            connection.once('error', err => {
                if (returned) return;
                returned = true;

                connection.close();
                return callback(err);
            });

            // 处理连接结束
            connection.once('end', () => {
                if (returned) return;
                returned = true;

                return callback(new Error('连接已关闭'));
            });

            // 完成验证的内部函数
            let finalize = () => {
                if (returned) return;
                returned = true;

                connection.quit();
                return callback(null, true);
            };

            // 连接SMTP服务器
            connection.connect(() => {
                if (returned) return;

                let authData = this.getAuth({});

                // 如果需要且支持认证，则进行登录验证
                if (authData && (connection.allowsAuth || options.forceAuth)) {
                    connection.login(authData, err => {
                        if (returned) return;

                        if (err) {
                            returned = true;
                            connection.close();
                            return callback(err);
                        }

                        finalize();
                    });
                }
                // 否则, 如果需要认证，则返回认证未认证错误
                else if (!authData && connection.allowsAuth && options.forceAuth) {
                    let err = new Error('未提供认证信息');
                    err.code = 'NoAuth';

                    returned = true;
                    connection.close();
                    return callback(err);
                }
                else finalize(); // 否则，直接完成验证
            });
        });

        return promise;
    }

    /**
     * 释放资源
     */
    close() {
        if (this.auth && this.auth.oauth2) this.auth.oauth2.removeAllListeners();// 如果使用OAuth2认证，则移除所有监听器
        this.emit('close');
    }
}

// 暴露给外部使用
module.exports = SmtpTransport;