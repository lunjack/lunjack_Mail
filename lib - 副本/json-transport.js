'use strict';

const { getLogger, formatRecipients, PK } = require('./shared');

/**
 * 生成用于输出JSON的传输对象
 *
 * @constructor
 * @param {Object} options 可选配置参数
 */
class JsonTransport {
    constructor(options = {}) {
        this.options = options;

        this.name = 'JsonTransport', this.version = PK.version; // 设置传输对象名称和版本

        // 初始化日志记录器
        this.logger = getLogger(this.options, { component: this.options.component || 'jsonTransport' });
    }

    /**
     * <p>编译mailcomposer消息并将其转发给发送处理器</p>
     *
     * @param {Object} mail MailComposer对象
     * @param {Function} done 发送完成后执行的回调函数
     */
    send(mail, done) {
        mail.message.keepBcc = true; // 保留BCC字段

        // 获取邮件信封信息和消息ID
        const envelope = mail.data.envelope || mail.message.getEnvelope();
        const messageId = mail.message.messageId();
        const recipients = formatRecipients(envelope.to);  // 处理收件人列表显示

        // 记录发送日志
        this.logger.info(
            { tnx: 'send', messageId }, '正在为 %s 构建JSON结构，收件人: <%s>', messageId, recipients.join(', ')
        );

        // 使用setImmediate确保异步执行
        setImmediate(() => {
            // 规范化邮件数据
            mail.normalize((err, data) => {
                if (err) {
                    // 记录错误信息
                    this.logger.error({ err, tnx: 'send', messageId }, '为 %s 构建JSON结构失败;错误信息: %s', messageId, err.message);
                    return done(err); // 返回错误
                }

                delete data.envelope, delete data.normalizedHeaders; // 删除不必要的字段
                // 成功返回处理结果(信封信息、消息ID和消息内容)
                return done(null, { envelope, messageId, message: this.options.skipEncoding ? data : JSON.stringify(data) });
            });
        });
    }
}

// 导出
module.exports = JsonTransport;