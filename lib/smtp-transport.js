'use strict';

// 引入所需模块
const EventEmitter = require('events');
const SmtpConnection = require('./smtp-connection');
const OAUTH2 = require('./xoauth2');
const { initSmtpConstructor, getSocket, createSmtpConnection, setupConnectionHandlers, createAuthConfig,
    prepareMessageForSending, handleSendResult, performSmtpAuthentication, verifySmtp } = require('./shared');
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
        const authData = { ...this.options?.auth, ...authOpts };
        return createAuthConfig(authData, this.logger, this.mailer, OAUTH2); // 创建认证配置
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

            const { options: newOp, connection } = createSmtpConnection(this, socketOp, SmtpConnection); // 创建并配置SMTP连接
            const state = { returned: false };
            const cleanC = setupConnectionHandlers(state, connection, callback, this);                   // 处理连接错误和结束事件
            // 发送消息
            const sendMessage = () => {
                const { envelope, readStream, from, to, messageId }
                    = prepareMessageForSending(mail, this.logger); // 邮件预处理

                connection.send(envelope, readStream, (err, info) => {
                    state.returned = true, connection.close();

                    const result = { err, info, from, to, messageId };
                    handleSendResult(result, callback, this.logger); // 处理发送结果
                });
            };
            // 连接SMTP服务器
            connection.connect(() => {
                if (state.returned) return;
                // 处理认证并发送消息
                const auth = this.getAuth(mail.data?.auth);
                performSmtpAuthentication(state, connection, auth, newOp, callback, this, sendMessage), cleanC();
            });
        });
    }

    /**
     * 验证SMTP配置
     *
     * @param {Function} callback 回调函数
     */
    verify(callback) {
        return verifySmtp(this, callback, SmtpConnection, this.auth);
    }

    // 释放资源
    close() {
        this.auth?.oauth2?.removeAllListeners();// 如果使用OAuth2认证，则移除所有监听器
        this.emit('close');
    }
}

// 导出
module.exports = SmtpTransport;