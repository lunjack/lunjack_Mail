'use strict';

const EventEmitter = require('events');
const XOAuth2 = require('../xoauth2');
const SmtpConnection = require('../smtp-connection');
const { formatRecipients, createProxyConnection } = require('../shared');

/**
 * 为连接池创建资源元素
 *
 * @constructor
 * @param {Object} pool SmtpPool实例
 */
class PoolResource extends EventEmitter {
    constructor(pool) {
        super();
        this.pool = pool, this.options = pool.options, this.logger = this.pool.logger; // 所属连接池,连接选项,日志记录器
        const { auth, authMethod } = this.options;

        // 配置认证信息
        if (auth) {
            const { user = '', pass, type = '', method = '', options } = auth;
            const newType = type.toString().toUpperCase();

            if (newType === 'OAUTH2') {
                const oauth2 = new XOAuth2(auth, this.logger);
                oauth2.provisionCallback = this.mailer?.get('oauth2_provision_cb') || oauth2.provisionCallback;
                oauth2.on('token', token => this.mailer.emit('token', token)).on('error', err => this.emit('error', err));
                this.auth = { type: 'OAUTH2', user, oauth2, method: 'XOAUTH2' };
            }
            else if (user || pass) {
                this.auth = {
                    type: newType || 'LOGIN', user, credentials: { user, pass, options },
                    method: method?.trim().toUpperCase() || authMethod || ''
                };
            }
        }

        this._connection = false, this._connected = false; // SMTP连接实例,连接状态标志
        this.messages = 0, this.available = true;          // 已发送消息计数,资源可用性标志
    }

    /**
     * 建立到SMTP服务器的连接
     *
     * @param {Function} callback 连接建立或失败后的回调函数
     */
    connect(callback) {
        // 从连接池获取socket
        this.pool.getSocket(this.options, (err, socketOp) => {
            if (err) return callback(err);

            // 使用公共函数处理代理socket和创建连接
            const { options: newOp, connection } = createProxyConnection(this.options, this.logger, socketOp, SmtpConnection);
            let returned = false;    // 防止重复回调的标志

            function cleanup() {
                if (returned) return;
                returned = true;
            };

            // 错误事件处理
            connection.once('error', err => {
                this.emit('error', err), cleanup();
                return callback(err);
            });

            // 连接结束事件处理
            connection.once('end', () => {
                this.close(), cleanup();

                // 设置超时检测意外关闭
                const timer = setTimeout(() => {
                    if (returned) return;
                    let err = new Error('意外的socket关闭');
                    if (connection?._socket?.upgrading) err.code = 'ETLS';  // 如果连接正在升级到TLS，则认为是STARTTLS连接错误
                    callback(err);
                }, 1000);

                try {
                    timer.unref();
                } catch (E) {
                    // 忽略非Node.js定时器实现环境的错误
                }
            });

            // 连接建立后的处理
            connection.connect(() => {
                if (returned) return;

                // 需要认证时的处理
                if (this.auth && (connection.allowsAuth || newOp.forceAuth))
                    connection.login(this.auth, err => {
                        cleanup();
                        this._isCallbackErr(err, callback);
                        this._connected = true, callback(null, true);
                    });
                // 否则，直接返回成功
                else {
                    returned = true, this._connected = true;
                    return callback(null, true);
                }
            });
        });
    }

    // 是否处理回调错误
    _isCallbackErr(err, callback) {
        if (err) {
            this.connection.close(), this.emit('error', err);
            return callback(err);
        }
    };

    /**
     * 使用当前配置发送邮件
     *
     * @param {Object} mail 邮件对象
     * @param {Function} callback 回调函数
     */
    send(mail, callback) {
        // 确保连接已建立
        if (!this._connected)
            return this.connect(err => {
                return err ? callback(err) : this.send(mail, callback);
            });

        const envelope = mail.message.getEnvelope();                      // 获取信封信息
        const messageId = mail.message.messageId();                       // 获取消息ID
        const { from, to } = envelope, recipients = formatRecipients(to); // 处理收件人列表显示
        const { dsn } = mail.data;
        if (dsn) envelope.dsn = dsn;                                     // 添加投递状态通知(DSN)支持

        // 记录发送日志
        this.logger.info({ tnx: 'send', messageId, cid: this.id }, '正在使用资源 #%s 发送消息 %s 至 <%s>',
            this.id, messageId, recipients.join(', ')
        );

        // 执行邮件发送
        this.connection.send(envelope, mail.message.createReadStream(), (err, info) => {
            this.messages++;    // 增加消息计数
            this._isCallbackErr(err, callback);
            info.envelope = { from, to }, info.messageId = messageId; // 构建响应信息

            // 异步处理资源限制检查
            setImmediate(() => {
                if (this.messages >= this.options.maxMessages) {
                    const err = new Error('资源耗尽'); // 达到最大消息限制
                    err.code = 'EMAXLIMIT', this.connection.close(), this.emit('error', err);
                }
                // 检查速率限制并标记为可用
                else this.pool._checkRateLimit(() => { this.available = true, this.emit('available') });
            });

            callback(null, info);
        });
    }

    /**
     * 关闭连接
     */
    close() {
        this._connected = false;
        this.auth?.oauth2?.removeAllListeners();      // 清理OAuth2监听器
        this.connection?.close(), this.emit('close'); // 关闭连接
    }
}

module.exports = PoolResource;