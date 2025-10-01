'use strict';

// 导入包信息和共享模块
const packageData = require('../package.json');
const shared = require('./shared');
/**./shared
 * 生成用于流式传输的 Transport 对象./xoauth2
 *../package.json
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
        this.version = packageData.version;

        // 初始化日志记录器
        this.logger = shared.getLogger(this.options, {
            component: this.options.component || 'stream-transport'
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
        // 在输出中保留 Bcc 字段
        mail.message.keepBcc = true;

        let envelope = mail.data.envelope || mail.message.getEnvelope();
        let messageId = mail.message.messageId();

        // 处理收件人信息显示
        let recipients = [].concat(envelope.to || []);
        if (recipients.length > 3) recipients.push('...以及另外 ' + recipients.splice(2).length + ' 个收件人');

        this.logger.info(
            {
                tnx: 'send', // 事务类型：发送
                messageId
            },
            '正在发送消息 %s 到 <%s>，使用 %s 换行符',
            messageId,
            recipients.join(', '),
            this.winbreak ? '<CR><LF>' : '<LF>'
        );

        // 使用 setImmediate 确保异步执行
        setImmediate(() => {
            let stream;

            try {
                // 创建消息读取流
                stream = mail.message.createReadStream();
            } catch (E) {
                this.logger.error(
                    {
                        err: E,
                        tnx: 'send',
                        messageId
                    },
                    '为 %s 创建发送流失败。%s',
                    messageId,
                    E.message
                );
                return done(E);
            }

            // 如果不使用缓冲区，直接返回流
            if (!this.options.buffer) {
                stream.once('error', err => {
                    this.logger.error(
                        {
                            err,
                            tnx: 'send',
                            messageId
                        },
                        '为 %s 创建消息失败。%s',
                        messageId,
                        err.message
                    );
                });
                return done(null, {
                    envelope: mail.data.envelope || mail.message.getEnvelope(),
                    messageId,
                    message: stream
                });
            }

            // 使用缓冲区模式，收集所有数据块
            let chunks = [];
            let chunklen = 0;
            stream.on('readable', () => {
                let chunk;
                while ((chunk = stream.read()) !== null) {
                    chunks.push(chunk);
                    chunklen += chunk.length;
                }
            });

            // 处理流错误
            stream.once('error', err => {
                this.logger.error(
                    {
                        err,
                        tnx: 'send',
                        messageId
                    },
                    '为 %s 创建消息失败。%s',
                    messageId,
                    err.message
                );
                return done(err);
            });

            // 流结束时返回缓冲区结果
            stream.on('end', () =>
                done(null, {
                    envelope: mail.data.envelope || mail.message.getEnvelope(),
                    messageId,
                    message: Buffer.concat(chunks, chunklen)
                })
            );
        });
    }
}

// 导出 StreamTransport 类
module.exports = StreamTransport;