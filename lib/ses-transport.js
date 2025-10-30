'use strict';

// 导入所需模块
const EventEmitter = require('events');
const LeWindows = require('./mime-node/le-windows');
const { getLogger, callbackPromise, formatRecipients, _handleReadableStream, PK } = require('./shared');

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
        this.ses = this.options.SES; // AWS SES 实例

        this.name = 'SesTransport', this.version = PK.version;

        // 初始化日志记录器
        this.logger = getLogger(this.options, { component: this.options.component || 'sesTransport' });
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
        const statObject = { ts: Date.now(), pending: true };  // 创建统计对象
        // 获取信封和消息ID
        const envelope = mail.data.envelope || mail.message.getEnvelope();
        const messageId = mail.message.messageId();
        const { from, to } = envelope;
        const recipients = formatRecipients(to);  // 处理收件人列表显示
        this.logger.info({ tnx: 'send', messageId }, '正在发送消息 %s 至 <%s>', messageId, recipients.join(', '));

        // 简单的 From 地址处理
        let fromAddress = from;
        try {
            const fromHeader = mail.message._headers?.find(header => header.key.toLowerCase() === 'from');
            if (fromHeader?.value) fromAddress = fromHeader.value;
        } catch (err) {
            this.logger.warn({ err, messageId }, '解析 From 头失败，使用默认发件人地址: %s', from);
        }
        // 错误处理
        const handleError = (err, errorMessage) => {
            this.logger.error({ err, tnx: 'send', messageId }, errorMessage, messageId, err.message);
            statObject.pending = false, callback(err);
        };

        /**
         * 获取原始消息内容
         * @param {Function} next 回调函数
         */
        const getRawMessage = next => {
            // 在 DKIM 签名中不使用 Message-ID 和 Date
            const d = mail.data._dkim = mail.data._dkim || {}, dMsgId = 'date:message-id';
            d.skipFields = (d.skipFields && typeof d.skipFields === 'string') ? `${d.skipFields}:${dMsgId}` : dMsgId;

            // 创建消息流
            const sourceStream = mail.message.createReadStream();
            const stream = sourceStream.pipe(new LeWindows()), chunks = [], chunklen = { value: 0 };

            // 读取流数据,错误处理和流结束处理
            stream.on('readable', () => _handleReadableStream(stream, chunks, chunklen));
            sourceStream.once('error', err => stream.emit('error', err));
            stream.once('error', err => { next(err); });
            stream.once('end', () => next(null, Buffer.concat(chunks, chunklen.value)));
        };

        // 异步执行发送过程
        setImmediate(() =>
            getRawMessage((err, raw) => {
                if (err) return handleError(err, '为 %s 创建消息失败。%s');

                // 构建 SES 消息对象
                const sesMessage = {
                    Content: { Raw: { Data: raw } }, FromEmailAddress: fromAddress, Destination: { ToAddresses: to },
                    ...(mail.data.ses || {}) // 添加自定义参数
                };

                // 获取区域并发送邮件
                this.getRegion((err, region) => {
                    if (err || !region) region = 'us-east-1'; // 默认区域
                    const command = new this.ses.SendEmailCommand(sesMessage);
                    this.ses.sesClient.send(command).then(data => {
                        if (region === 'us-east-1') region = 'email';
                        statObject.pending = false; // 邮件发送完成
                        callback(null, {
                            envelope: { from, to },
                            messageId: '<' + data.MessageId + (!/@/.test(data.MessageId) ? '@' + region + '.amazonses.com' : '') + '>',
                            response: data.MessageId, raw
                        });
                    }).catch(err => { handleError(err, '发送 %s 时出错: %s'); });
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
        let promise;
        if (!callback) promise = new Promise((resolve, reject) => { callback = callbackPromise(resolve, reject); });

        // 忽略某些特定错误，仍然认为验证成功
        const cb = err => callback(
            err && !['InvalidParameterValue', 'MessageRejected'].includes(err?.code || err?.Code || err?.name) ? err : null, true
        );

        const iEmail = 'invalid@invalid';
        // 创建测试用的无效消息
        const sesMessage = {
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

// 导出 SesTransport 类
module.exports = SesTransport;