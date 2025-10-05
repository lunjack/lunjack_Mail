'use strict';

const packageData = require('../package.json');
const { getLogger } = require('./shared'); // 导入共享工具函数

/**
 * 生成用于输出JSON的传输对象
 *
 * @constructor
 * @param {Object} options 可选配置参数
 */
class JsonTransport {
    constructor(options = {}) {
        this.options = options;

        // 设置传输对象名称和版本
        this.name = 'JsonTransport';
        this.version = packageData.version;

        // 初始化日志记录器
        this.logger = getLogger(this.options, {
            component: this.options.component || 'jsonTransport'
        });
    }

    /**
     * <p>编译mailcomposer消息并将其转发给发送处理器</p>
     *
     * @param {Object} mail MailComposer对象
     * @param {Function} done 发送完成后执行的回调函数
     */
    send(mail, done) {
        // 保留Bcc头信息（sendmail通常会自行移除）
        mail.message.keepBcc = true;

        // 获取邮件信封信息和消息ID
        let envelope = mail.data.envelope || mail.message.getEnvelope();
        let messageId = mail.message.messageId();

        // 处理收件人信息显示
        let recipients = [].concat(envelope.to || []);
        // 仅显示前3个收件人，超过部分用省略号表示
        if (recipients.length > 3) recipients.push('...以及另外 ' + recipients.splice(2).length + ' 个收件人');

        // 记录发送日志
        this.logger.info(
            {
                tnx: 'send', // 事务类型：发送
                messageId    // 消息ID
            },
            '正在为 %s 构建JSON结构，收件人: <%s>',
            messageId,
            recipients.join(', ')
        );

        // 使用setImmediate确保异步执行
        setImmediate(() => {
            // 规范化邮件数据
            mail.normalize((err, data) => {
                if (err) {
                    // 记录错误信息
                    this.logger.error(
                        {
                            err,        // 错误对象
                            tnx: 'send', // 事务类型：发送
                            messageId   // 消息ID
                        },
                        '为 %s 构建JSON结构失败。错误信息: %s',
                        messageId,
                        err.message
                    );
                    return done(err); // 返回错误
                }

                // 移除不需要的字段
                delete data.envelope;
                delete data.normalizedHeaders;

                // 成功返回处理结果
                return done(null, {
                    envelope,   // 信封信息
                    messageId,  // 消息ID
                    // 根据配置决定是否跳过编码
                    message: this.options.skipEncoding ? data : JSON.stringify(data)
                });
            });
        });
    }
}

// 导出JsonTransport类
module.exports = JsonTransport;