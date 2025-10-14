'use strict';

// 导入所需模块
const EventEmitter = require('events');
const packageData = require('../package.json');
const LeWindows = require('./mime-node/le-windows');
const MimeNode = require('./mime-node');
const { getLogger, callbackPromise, formatRecipients } = require('./shared');

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

        this.name = 'SesTransport';
        this.version = packageData.version;

        // 初始化日志记录器
        this.logger = getLogger(this.options, {
            component: this.options.component || 'sesTransport'
        });
    }

    /**
     * 获取 AWS 区域
     * @param {Function} cb 回调函数
     */
    getRegion(cb) {
        if (this.ses.sesClient.config && typeof this.ses.sesClient.config.region === 'function') {
            // 支持 Promise 方式获取区域
            return this.ses.sesClient.config
                .region()
                .then(region => cb(null, region))
                .catch(err => cb(err));
        }
        return cb(null, false);
    }

    /**
     * 编译 mailcomposer 消息并将其转发到 SES
     *
     * @param {Object} mail MailComposer 对象
     * @param {Function} callback 发送完成时运行的回调函数
     */
    send(mail, callback) {
        // 创建统计对象
        let statObject = {
            ts: Date.now(),
            pending: true
        };

        // 查找 From 头信息
        let fromHeader = mail.message._headers.find(header => /^from$/i.test(header.key));
        if (fromHeader) {
            let mimeNode = new MimeNode('text/plain');
            fromHeader = mimeNode._convertAddresses(mimeNode._parseAddresses(fromHeader.value));
        }

        // 获取信封和消息ID
        let envelope = mail.data.envelope || mail.message.getEnvelope();
        let messageId = mail.message.messageId();
        let recipients = formatRecipients(envelope.to);  // 处理收件人列表显示

        this.logger.info(
            {
                tnx: 'send',
                messageId
            },
            '正在发送消息 %s 至 <%s>',
            messageId,
            recipients.join(', ')
        );

        /**
         * 获取原始消息内容
         * @param {Function} next 回调函数
         */
        let getRawMessage = next => {
            // 在 DKIM 签名中不使用 Message-ID 和 Date
            if (!mail.data._dkim) mail.data._dkim = {};

            if (mail.data._dkim.skipFields && typeof mail.data._dkim.skipFields === 'string')
                mail.data._dkim.skipFields += ':date:message-id';
            else mail.data._dkim.skipFields = 'date:message-id';


            // 创建消息流
            let sourceStream = mail.message.createReadStream();
            let stream = sourceStream.pipe(new LeWindows());
            let chunks = [];
            let chunklen = 0;

            // 读取流数据
            stream.on('readable', () => {
                let chunk;
                while ((chunk = stream.read()) !== null) {
                    chunks.push(chunk);
                    chunklen += chunk.length;
                }
            });

            // 错误处理
            sourceStream.once('error', err => stream.emit('error', err));
            stream.once('error', err => {
                next(err);
            });

            // 流结束处理
            stream.once('end', () => next(null, Buffer.concat(chunks, chunklen)));
        };

        // 异步执行发送过程
        setImmediate(() =>
            getRawMessage((err, raw) => {
                if (err) {
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
                    statObject.pending = false;
                    return callback(err);
                }

                // 构建 SES 消息对象
                let sesMessage = {
                    Content: {
                        Raw: {
                            Data: raw // 必需参数
                        }
                    },
                    FromEmailAddress: fromHeader ? fromHeader : envelope.from,
                    Destination: {
                        ToAddresses: envelope.to
                    }
                };

                // 合并额外的 SES 配置
                Object.keys(mail.data.ses || {}).forEach(key => {
                    sesMessage[key] = mail.data.ses[key];
                });

                // 获取区域并发送邮件
                this.getRegion((err, region) => {
                    if (err || !region) region = 'us-east-1'; // 默认区域

                    const command = new this.ses.SendEmailCommand(sesMessage);
                    const sendPromise = this.ses.sesClient.send(command);

                    sendPromise
                        .then(data => {
                            if (region === 'us-east-1') region = 'email';

                            statObject.pending = true;
                            // 成功回调
                            callback(null, {
                                envelope: {
                                    from: envelope.from,
                                    to: envelope.to
                                },
                                messageId: '<' + data.MessageId + (!/@/.test(data.MessageId) ? '@' + region + '.amazonses.com' : '') + '>',
                                response: data.MessageId,
                                raw
                            });
                        })
                        .catch(err => {
                            this.logger.error(
                                {
                                    err,
                                    tnx: 'send'
                                },
                                '发送 %s 时出错: %s',
                                messageId,
                                err.message
                            );
                            statObject.pending = false;
                            callback(err);
                        });
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
        if (!callback)
            promise = new Promise((resolve, reject) => {
                callback = callbackPromise(resolve, reject);
            });

        const cb = err => {
            // 忽略某些特定错误，仍然认为验证成功
            if (err && !['InvalidParameterValue', 'MessageRejected'].includes(err.code || err.Code || err.name)) return callback(err);
            return callback(null, true);
        };

        // 创建测试用的无效消息
        const sesMessage = {
            Content: {
                Raw: {
                    Data: Buffer.from('From: <invalid@invalid>\r\nTo: <invalid@invalid>\r\n Subject: Invalid\r\n\r\nInvalid')
                }
            },
            FromEmailAddress: 'invalid@invalid',
            Destination: {
                ToAddresses: ['invalid@invalid']
            }
        };

        this.getRegion((err, region) => {
            if (err || !region) region = 'us-east-1';

            const command = new this.ses.SendEmailCommand(sesMessage);
            const sendPromise = this.ses.sesClient.send(command);

            sendPromise.then(data => cb(null, data)).catch(err => cb(err));
        });

        return promise;
    }
}

// 导出 SesTransport 类
module.exports = SesTransport;