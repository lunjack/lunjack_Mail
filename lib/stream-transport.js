'use strict';

// 导入包信息和共享模块
const { PK, getLogger, prepareMessageForSending, resolveStream } = require('./shared');
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
        this.options = options, this.name = 'StreamTransport', this.version = PK.version;

        const { component = 'streamTransport', newline = '' } = this.options;
        this.logger = getLogger(this.options, { component });                                         // 初始化日志记录器
        this.winbreak = ['win', 'windows', 'dos', '\r\n'].includes(newline.toString().toLowerCase()); // 根据配置确定换行符类型
    }

    /**
     * 编译 mailcomposer 消息并将其转发给发送处理器
     *
     * @param {Object} emailMessage MailComposer 对象
     * @param {Function} callback 发送完成时运行的回调函数
     */
    send(mail, done) {
        const { envelope, messageId, readStream } // 邮件预处理
            = prepareMessageForSending(mail, this.logger, '', { transportType: 'stream', winbreak: this.winbreak });

        // 使用 setImmediate 确保异步执行
        setImmediate(() => {
            const handleError = (err, context) => {
                this.logger.error({ err, tnx: 'send', messageId }, context, messageId, err.message), done(err);
            };

            // 如果不使用缓冲区，直接返回流(流可读时才认为成功)
            if (!this.options.buffer) {
                readStream.once('readable', () => done(null, { envelope, messageId, message: readStream }))
                    .once('error', err => handleError(err, '为 %s 创建消息流失败。%s'))
            }

            // 将流数据读取到Buffer中
            resolveStream(readStream, (err, value) => err ? handleError(err) : done(null, { envelope, messageId, message: value }));
        });
    }
}

// 导出
module.exports = StreamTransport;