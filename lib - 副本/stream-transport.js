'use strict';

// 导入包信息和共享模块
const { getLogger, formatRecipients, handleReadableStream, PK } = require('./shared');
/**
 * 生成用于流式传输的 Transport 对象./xoauth2
 * 可用的选项如下：
 *
 *  **buffer** 如果为 true，则将消息作为 Buffer 对象而不是返回流
 *  **newline** 换行符类型，可以是 'windows' 或 'unix'
 *
 * @constructor
 * @param {Object} 可选的配置参数
 */
class StreamTransport {
    constructor(options = {}) {
        this.options = options;

        this.name = 'StreamTransport';
        this.version = PK.version;

        // 初始化日志记录器
        this.logger = getLogger(this.options, {
            component: this.options.component || 'streamTransport'
        });

        // 根据配置确定换行符类型
        this.winbreak = ['win', 'windows', 'dos', '\r\n'].includes((options.newline || '').toString().toLowerCase());
    }

    /**
     * 编译 mailcomposer 消息并将其转发给发送处理器
     *
     * @param {Object} emailMessage MailComposer 对象
     * @param {Function} callback 发送完成时运行的回调函数
     */
    send(mail, done) {
        mail.message.keepBcc = true;                       // 在输出中保留 Bcc 字段

        const envelope = mail.data.envelope || mail.message.getEnvelope();
        const messageId = mail.message.messageId();
        const recipients = formatRecipients(envelope.to);  // 处理收件人列表显示

        this.logger.info({ tnx: 'send', messageId }, '正在发送消息 %s 到 <%s>，使用 %s 换行符', messageId,
            recipients.join(', '), this.winbreak ? '<CR><LF>' : '<LF>');

        // 使用 setImmediate 确保异步执行
        setImmediate(() => {
            const handleError = (err, context) => {
                this.logger.error({ err, tnx: 'send', messageId }, context, messageId, err.message);
                done(err);
            };
            let stream;

            try {
                stream = mail.message.createReadStream();  // 创建消息读取流
            } catch (E) {
                handleError(E, '为 %s 创建发送流失败。%s');
            }

            // 如果不使用缓冲区，直接返回流
            if (!this.options.buffer) {
                stream.once('error', err => { handleError(err, '为 %s 创建消息失败。%s') });
                return done(null, { envelope, messageId, message: stream });
            }

            // 使用缓冲区模式，收集所有数据块
            const chunks = [], chunklen = { value: 0 };

            stream.on('readable', () => handleReadableStream(stream, chunks, chunklen));

            // 处理流错误
            stream.once('error', err => handleError(err, '为 %s 创建消息失败。%s'));

            // 流结束时返回缓冲区结果
            stream.on('end', () => done(null, { envelope, messageId, message: Buffer.concat(chunks, chunklen.value) }));
        });
    }
}

// 导出 StreamTransport 类
module.exports = StreamTransport;