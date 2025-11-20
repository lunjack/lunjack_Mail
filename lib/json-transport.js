'use strict';

const { PK, getLogger, prepareMessageForSending } = require('./shared');

/**
 * 生成用于输出JSON的传输对象
 *
 * @constructor
 * @param {Object} options 可选配置参数
 */
class JsonTransport {
    constructor(options = {}) {
        this.options = options, this.name = 'JsonTransport', this.version = PK.version;                  // 设置传输对象名称和版本
        this.logger = getLogger(this.options, { component: this.options.component || 'jsonTransport' }); // 初始化日志记录器
    }

    /**
     * <p>编译mailcomposer消息并将其转发给发送处理器</p>
     *
     * @param {Object} mail MailComposer对象
     * @param {Function} done 发送完成后执行的回调函数
     */
    send(mail, done) {
        const { normalize, envelope, messageId }
            = prepareMessageForSending(mail, this.logger, '', { transportType: 'json' }, done); // 邮件预处理

        setImmediate(() => {
            normalize((err, data) => {
                if (err) {
                    this.logger.error({ err, tnx: 'send', messageId }, '为 %s 构建JSON结构失败: %s', messageId, err.message);
                    return done(err);
                }
                delete data.envelope, delete data.normalizedHeaders;
                return done(null, { envelope, messageId, message: this.options.skipEncoding ? data : JSON.stringify(data) });
            });
        });
    }
}

// 导出
module.exports = JsonTransport;