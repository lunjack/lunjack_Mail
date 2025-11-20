'use strict';

const EventEmitter = require('events');
const OAUTH2 = require('../xoauth2');
const SmtpConnection = require('../smtp-connection');
const { createSmtpConnection, setupConnectionHandlers, performSmtpAuthentication, prepareMessageForSending,
    handleSendResult, createAuthConfig } = require('../shared');

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
        if (this.options.auth) this.auth = this.getAuth({});                           // 如果提供了认证信息，则设置认证

        this._connection = false, this._connected = false;                             // SMTP连接实例,连接状态标志
        this.messages = 0, this.available = true;                                      // 已发送消息计数,资源可用性标志
    }

    /**
     * 获取认证信息
     * @param {Object} authOpts 认证选项
     * @returns {Object|boolean} 认证对象或false
     */
    getAuth(authOpts) {
        if (!authOpts) return this.auth;
        const authData = { ...this.options?.auth, ...authOpts, authMethod: this.options.authMethod || '' };
        return createAuthConfig(authData, this.logger, this.mailer, OAUTH2);           // 创建认证配置
    }

    /**
     * 建立到SMTP服务器的连接
     *
     * @param {Function} callback 连接建立或失败后的回调函数
     */
    connect(callback) {
        this.pool.getSocket(this.options, (err, socketOp) => {
            if (err) return callback(err);
            // 创建和配置SMTP连接并处理连接错误和结束事件
            const { options: newOp, connection } = createSmtpConnection(this, socketOp, SmtpConnection),
                state = { returned: false }, cleanC = setupConnectionHandlers(state, connection, callback, this);

            // 连接建立后的处理(执行 SMTP 认证和清理监听)
            connection.connect(() => {
                if (state.returned) return;
                performSmtpAuthentication(state, connection, this.auth, newOp, callback, this), cleanC();
            });
        });
    }

    /**
     * 使用当前配置发送邮件
     *
     * @param {Object} mail 邮件对象
     * @param {Function} callback 回调函数
     */
    send(mail, callback) {
        if (!this._connected) return this.connect(err => err ? callback(err) : this.send(mail, callback));

        const { envelope, readStream, from, to, messageId }
            = prepareMessageForSending(mail, this.logger, this.id); // 邮件预处理
        // 执行邮件发送
        this.connection.send(envelope, readStream, (err, info) => {
            this.messages++; // 增加消息计数

            // 异步处理资源限制检查
            setImmediate(() => {
                if (this.messages >= this.options.maxMessages) {
                    const err = new Error('资源耗尽');        // 达到最大消息限制
                    err.code = 'EMAXLIMIT', this.connection.close(), this.emit('error', err);
                }
                // 检查速率限制并标记为可用
                else this.pool._checkRateLimit(() => this.available = true, this.emit('available'));
            });
            const result = { err, info, from, to, messageId };
            handleSendResult(result, callback, this.logger); // 处理发送结果
        });
    }

    /**
     * 关闭连接
     */
    close() {
        this._connected = false, this.auth?.oauth2?.removeAllListeners(), this.connection?.close(), this.emit('close');
    }
}

module.exports = PoolResource;