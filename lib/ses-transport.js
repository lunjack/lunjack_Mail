'use strict';

// 导入所需模块
const EventEmitter = require('events');
const LeWindows = require('./mime-node/le-windows');
const { PK, getLogger, callbackPromise, prepareMessageForSending, resolveStream } = require('./shared');

/**
 * 生成用于 AWS SES 的传输对象
 *
 * @constructor
 * @param {Object} options 可选配置参数
 */
class SesTransport extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = options;
        const { SES, component = 'sesTransport' } = this.options;
        this.ses = SES, this.name = 'SesTransport', this.version = PK.version;
        this.logger = getLogger(this.options, { component }); // 初始化日志记录器
    }

    /**
     * 获取 AWS 区域
     * @param {Function} cb 回调函数
     */
    getRegion(cb) {
        const regionFunc = this.ses.sesClient.config?.region;
        // 如果是函数，则调用该函数并返回结果,否则返回结果
        return typeof regionFunc === 'function' ? regionFunc().then(r => cb(null, r)).catch(cb) : cb(null, false);
    }

    /**
     * 编译 mailcomposer 消息并将其转发到 SES
     *
     * @param {Object} mail MailComposer 对象
     * @param {Function} callback 发送完成时运行的回调函数
     */
    send(mail, callback) {
        const statObject = { ts: Date.now(), pending: true },  // 创建统计对象
            { messageId, _dkim = {}, from, to, readStream, ses = {} }
                = prepareMessageForSending(mail, this.logger, '', { transportType: 'ses' }), // 邮件预处理

            // 错误处理
            handleError = (err, errorMessage) => {
                this.logger.error({ err, tnx: 'send', messageId }, errorMessage, messageId, err.message);
                statObject.pending = false, callback(err);
            },

            /**
             * 获取原始消息内容
             * @param {Function} next 回调函数
             */
            getRawMessage = next => {
                // 在 DKIM 签名中不使用 Message-ID 和 Date; 将流数据读取到Buffer中
                const sF = _dkim.skipFields, dMsgId = 'date:message-id', stream = readStream.pipe(new LeWindows()); // 创建消息流
                _dkim.skipFields = (sF && typeof sF === 'string') ? `${sF}:${dMsgId}` : dMsgId, resolveStream(stream, next);
            };

        // 异步执行发送过程
        setImmediate(() =>
            getRawMessage((err, raw) => {
                if (err) return handleError(err, '为 %s 创建消息失败。%s');

                // 构建 SES 消息对象(添加自定义参数: ses)
                const sesMessage = {
                    Content: { Raw: { Data: raw } }, FromEmailAddress: from, Destination: { ToAddresses: to }, ...ses
                };

                // 获取区域并发送邮件
                this.getRegion((err, region) => {
                    if (err || !region) region = 'us-east-1'; // 默认区域
                    const command = new this.ses.SendEmailCommand(sesMessage);
                    this.ses.sesClient.send(command).then(d => {
                        if (region === 'us-east-1') region = 'email';
                        statObject.pending = false; // 邮件发送完成
                        callback(null, {
                            envelope: { from, to },
                            messageId: `<${d.MessageId}${(!d.MessageId.includes('@') ? `@${region}.amazonses.com` : '')}>`,
                            response: d.MessageId, raw
                        });
                    }).catch(err => handleError(err, '发送 %s 时出错: %s'));
                });
            })
        );
    }

    /**
     * 验证 SES 配置
     *
     * @param {Function} callback 回调函数
     * @return {Promise} 如果没有提供回调函数，则返回 Promise
     */
    verify(callback) {
        const promise = !callback ? new Promise((resolve, reject) => callback = callbackPromise(resolve, reject)) : null,
            // 忽略某些特定错误，仍然认为验证成功
            cb = err => callback(
                err && !['InvalidParameterValue', 'MessageRejected'].includes(err?.code || err?.Code || err?.name) ? err : null, true
            ),

            iEmail = 'invalid@invalid',
            // 创建测试用的无效消息
            sesMessage = {
                Content: { Raw: { Data: Buffer.from(`From: <${iEmail}>\r\nTo: <${iEmail}>\r\nSubject: Invalid\r\n\r\nInvalid`) } },
                FromEmailAddress: iEmail, Destination: { ToAddresses: [iEmail] }
            };

        this.getRegion((err, region) => {
            if (err || !region) region = 'us-east-1';
            const command = new this.ses.SendEmailCommand(sesMessage);
            this.ses.sesClient.send(command).then(data => cb(null, data), err => cb(err));
        });

        return promise;
    }
}

// 导出
module.exports = SesTransport;