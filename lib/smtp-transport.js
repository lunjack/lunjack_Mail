'use strict';

// 引入所需模块
const EventEmitter = require('events');
const SmtpConnection = require('./smtp-connection');
const XOAuth2 = require('./xoauth2');
const { callbackPromise, formatRecipients, initSmtpConstructor, getSocket, createProxyConnection } = require('./shared');
/**
 * 为lunjack-mail创建SMTP传输对象./fetch
 *
 * @constructor
 * @param {Object} options 连接选项
 */
class SmtpTransport extends EventEmitter {
    constructor(options = {}) {
        super();
        this.name = 'SMTP';
        initSmtpConstructor(this, options, SmtpConnection, 'smtpTransport');  // 初始化SMTP连接
        if (this.options.auth) this.auth = this.getAuth({});                  // 如果提供了认证信息，则设置认证
    }

    /**
     * 获取认证信息
     * @param {Object} authOpts 认证选项
     * @returns {Object|boolean} 认证对象或false
     */
    getAuth(authOpts) {
        if (!authOpts) return this.auth;

        let hasAuth = false, authData = {};
        const mergeAuthData = source => {
            if (source && typeof source === 'object' && Object.keys(source).length > 0) Object.assign(authData, source), hasAuth = true;
        };
        mergeAuthData(this.options?.auth);  // 从选项复制认证数据
        mergeAuthData(authOpts);            // 从参数复制认证数据

        if (!hasAuth) return false;
        // 根据认证类型处理不同的认证方式
        const { type = '', service, user = '', pass, options, method = '', authMethod } = authData
        const newType = type.toString().toUpperCase()
        if (newType === 'OAUTH2') {
            if (!service && !user) return false;

            const oauth2 = new XOAuth2(authData, this.logger);
            oauth2.provisionCallback = this.mailer?.get('oauth2_provision_cb') || oauth2.provisionCallback;
            oauth2.on('token', token => this.mailer.emit('token', token)).on('error', err => this.emit('error', err));
            return { type: 'OAUTH2', user, oauth2, method: 'XOAUTH2' };
        }

        // 否则使用LOGIN认证方式
        return {
            type: newType || 'LOGIN', user, credentials: { user, pass, options },
            method: method?.trim().toUpperCase() || authMethod || ''
        };
    }

    /**
     * 使用选定的设置发送电子邮件
     *
     * @param {Object} mail 邮件对象
     * @param {Function} callback 回调函数
     */
    send(mail, callback) {
        getSocket(this.options, (err, socketOp) => {
            if (err) return callback(err);

            // 使用公共函数处理代理socket和创建连接
            const { options: newOp, connection } = createProxyConnection(this.options, this.logger, socketOp, SmtpConnection);
            let returned = false;
            function cleanup() {
                if (returned) return;
                returned = true;
            };
            function callbackErr(err) {
                returned = true, connection.close();
                return callback(err);
            };
            // 处理连接错误
            connection.once('error', err => {
                if (returned) return;
                callbackErr(err);
            });

            // 处理连接结束
            connection.once('end', () => {
                if (returned) return;

                let timer = setTimeout(() => {
                    cleanup()
                    let err = new Error('意外的套接字关闭');
                    if (connection?._socket?.upgrading) err.code = 'ETLS'; // 如果连接正在升级，则将错误代码设置为ETLS
                    callback(err);
                }, 1000);

                try { timer.unref() } catch (E) { }
            });
            const { data, message } = mail, { dsn, auth } = data;
            // 发送消息的内部函数
            let sendMessage = () => {
                const envelope = message.getEnvelope(), messageId = message.messageId();
                const { from, to } = envelope;
                const recipients = formatRecipients(to);  // 处理收件人列表显示
                if (dsn) envelope.dsn = dsn;
                this.logger.info({ tnx: 'send', messageId }, '正在发送消息 %s 给 <%s>', messageId, recipients.join(', '));

                // 实际发送消息
                connection.send(envelope, message.createReadStream(), (err, info) => {
                    returned = true, connection.close();
                    if (err) {
                        this.logger.error({ err, tnx: 'send' }, '发送 %s 时出错: %s', messageId, err.message);
                        return callback(err);
                    }
                    info.envelope = { from, to }, info.messageId = messageId;
                    try {
                        return callback(null, info);
                    } catch (E) {
                        this.logger.error({ err: E, tnx: 'callback' }, '处理 %s 的回调时出错: %s', messageId, E.message);
                    }
                });
            };

            // 连接SMTP服务器
            connection.connect(() => {
                if (returned) return;

                const sAuth = this.getAuth(auth);
                // 如果需要且支持认证，则进行登录
                if (sAuth && (connection.allowsAuth || newOp.forceAuth)) {
                    connection.login(sAuth, err => {
                        sAuth && sAuth !== this.auth && sAuth.oauth2?.removeAllListeners();
                        if (returned) return;
                        if (err) callbackErr(err);
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
        // 如果没有提供回调，则创建Promise
        const promise = !callback ? new Promise((resolve, reject) => callback = callbackPromise(resolve, reject)) : null;

        getSocket(this.options, (err, socketOp) => {
            if (err) return callback(err);

            // 使用公共函数处理代理socket和创建连接
            const { options: newOp, connection } = createProxyConnection(this.options, this.logger, socketOp, SmtpConnection);
            let returned = false;

            function cleanup() {
                if (returned) return;
                returned = true;
            };
            function callbackErr(err) {
                returned = true, connection.close();
                return callback(err);
            };

            // 处理连接错误
            connection.once('error', err => {
                if (returned) return;
                callbackErr(err);
            });

            // 处理连接结束
            connection.once('end', () => {
                cleanup()
                return callback(new Error('连接已关闭'));
            });

            // 完成验证的内部函数
            let finalize = () => {
                cleanup(), connection.quit();
                return callback(null, true);
            };

            // 连接SMTP服务器
            connection.connect(() => {
                if (returned) return;
                const authData = this.getAuth({});
                const { allowsAuth } = connection, { forceAuth } = newOp;
                // 如果需要且支持认证，则进行登录验证
                if (authData && (allowsAuth || forceAuth)) {
                    connection.login(authData, err => {
                        if (returned) return;
                        if (err) callbackErr(err);
                        finalize();
                    });
                }
                // 否则, 如果需要认证，则返回认证未认证错误
                else if (!authData && allowsAuth && forceAuth) {
                    let err = new Error('未提供认证信息');
                    err.code = 'NoAuth', callbackErr(err);
                }
                else finalize(); // 否则，直接完成验证
            });
        });

        return promise
    }

    // 释放资源
    close() {
        this.auth?.oauth2?.removeAllListeners();// 如果使用OAuth2认证，则移除所有监听器
        this.emit('close');
    }
}

// 导出
module.exports = SmtpTransport;