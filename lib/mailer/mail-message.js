'use strict';

// 引入所需模块
const MimeNode = require('../mime-node');
const { resolveContent } = require('../shared');
const { regexs, resetRegex } = require('./regex');
const { detectExtension, detectMimeType, isPlainText, encodeWord } = require('../mime-funcs');

// 定义 MailMessage 类
class MailMessage {
    // 构造函数，初始化邮件消息对象
    constructor(mailer, data = {}) {
        this.mailer = mailer; // 邮件发送器实例
        this.data = {}; // 存储邮件数据
        this.message = null; // MimeNode 实例

        let options = mailer.options || {}; // 邮件发送器选项
        let defaults = mailer._defaults || {}; // 默认配置

        // 将传入的数据复制到 this.data
        Object.keys(data).forEach(key => {
            this.data[key] = data[key];
        });

        // 确保 headers 对象存在
        this.data.headers = this.data.headers || {};

        // 应用默认配置
        Object.keys(defaults).forEach(key => {
            if (!(key in this.data)) this.data[key] = defaults[key]; // 如果没有设置，则使用默认值
            else if (key === 'headers')
                Object.keys(defaults.headers).forEach(key => {
                    // headers 如果没有设置，则使用默认值
                    if (!(key in this.data.headers)) this.data.headers[key] = defaults.headers[key];
                });
        });

        // 强制应用 transporter 选项中的特定键
        ['disableFileAccess', 'disableUrlAccess', 'normalizeHeaderKey'].forEach(key => {
            if (key in options) this.data[key] = options[key]; // 如果在选项中设置，则使用选项值
        });
    }

    // 解析内容方法（代理给 resolveContent）
    resolveContent(...args) {
        return resolveContent(...args);
    }

    // 解析所有内容（文本、HTML、附件等）
    resolveAll(callback) {
        // 定义需要解析的内容键
        let keys = [
            [this.data, 'html'],
            [this.data, 'text'],
            [this.data, 'watchHtml'],
            [this.data, 'amp'],
            [this.data, 'icalEvent']
        ];

        // 如果有替代内容，则添加到键中
        if (this.data.alternatives && this.data.alternatives.length)
            this.data.alternatives.forEach((alternative, i) => {
                keys.push([this.data.alternatives, i]);
            });

        // 处理附件
        if (this.data.attachments && this.data.attachments.length) {
            this.data.attachments.forEach((attachment, i) => {
                // 如果没有文件名，则从路径或href中提取，或使用默认名称
                if (!attachment.filename) {
                    attachment.filename = (attachment.path || attachment.href || '').split('/').pop().split('?').shift()
                        || 'attachment-' + (i + 1);
                    // 如果没有扩展名，则根据内容类型添加
                    if (attachment.filename.indexOf('.') < 0)
                        attachment.filename += '.' + detectExtension(attachment.contentType);
                }

                // 如果没有内容类型，则根据文件名、路径或href检测
                if (!attachment.contentType) attachment.contentType
                    = detectMimeType(attachment.filename || attachment.path || attachment.href || 'bin');

                keys.push([this.data.attachments, i]);
            });
        }

        let mimeNode = new MimeNode(); // 创建 MimeNode 实例用于地址解析

        // 处理地址字段（from, to, cc, bcc, sender, replyTo）
        let addressKeys = ['from', 'to', 'cc', 'bcc', 'sender', 'replyTo'];

        addressKeys.forEach(address => {
            let value;
            // 如果已有消息，从消息头解析地址
            if (this.message)
                value = [].concat(mimeNode._parseAddresses(this.message.getHeader(
                    address === 'replyTo' ? 'reply-to' : address)) || []);
            // 否则直接从数据中解析
            else if (this.data[address]) value = [].concat(mimeNode._parseAddresses(this.data[address]) || []);

            if (value && value.length) this.data[address] = value; // 如果有值，则保存到数据中
            else if (address in this.data) this.data[address] = null; // 否则删除数据中的值
        });

        // 处理单值地址字段（from, sender）
        let singleKeys = ['from', 'sender'];
        singleKeys.forEach(address => {
            // 如果有值，则保存到数据中
            if (this.data[address]) this.data[address] = this.data[address].shift();
        });

        // 递归解析所有内容
        let pos = 0;
        let resolveNext = () => {
            if (pos >= keys.length) return callback(null, this.data); // 所有内容解析完成

            let args = keys[pos++];
            if (!args[0] || !args[0][args[1]]) return resolveNext(); // 跳过空值

            resolveContent(...args, (err, value) => {
                if (err) return callback(err); // 发生错误，返回错误

                // 创建内容节点，保留原始数据的其他属性
                let node = {
                    content: value
                };
                if (args[0][args[1]] && typeof args[0][args[1]] === 'object' && !Buffer.isBuffer(args[0][args[1]])) {
                    Object.keys(args[0][args[1]]).forEach(key => {
                        // 如果没有在节点中，则从原始数据中复制属性
                        if (!(key in node) && !['content', 'path', 'href', 'raw'].includes(key)) node[key] = args[0][args[1]][key];
                    });
                }

                args[0][args[1]] = node; // 更新数据为节点对象
                resolveNext(); // 继续解析下一个
            });
        };

        // 使用 setImmediate 异步开始解析
        setImmediate(() => resolveNext());
    }

    // 规范化邮件数据
    normalize(callback) {
        let envelope = this.data.envelope || this.message.getEnvelope(); // 获取信封信息
        let messageId = this.message.messageId(); // 获取消息ID

        // 首先解析所有内容
        this.resolveAll((err, data) => {
            if (err) return callback(err); // 如果解析失败，返回错误

            data.envelope = envelope; // 设置信封
            data.messageId = messageId; // 设置消息ID

            // 处理文本内容，转换为字符串
            ['html', 'text', 'watchHtml', 'amp'].forEach(key => {
                if (data[key] && data[key].content) {
                    // 如果内容是字符串或Buffer，则直接使用，否则转换为字符串
                    if (typeof data[key].content === 'string') data[key] = data[key].content;
                    else if (Buffer.isBuffer(data[key].content)) data[key] = data[key].content.toString();
                }
            });

            // 处理日历事件，转换为base64编码
            if (data.icalEvent && Buffer.isBuffer(data.icalEvent.content)) {
                data.icalEvent.content = data.icalEvent.content.toString('base64');
                data.icalEvent.encoding = 'base64';
            }

            // 处理替代内容，转换为base64编码
            if (data.alternatives && data.alternatives.length)
                data.alternatives.forEach(alternative => {
                    if (alternative && alternative.content && Buffer.isBuffer(alternative.content)) {
                        alternative.content = alternative.content.toString('base64');
                        alternative.encoding = 'base64';
                    }
                });

            // 处理附件，转换为base64编码
            if (data.attachments && data.attachments.length)
                data.attachments.forEach(attachment => {
                    if (attachment && attachment.content && Buffer.isBuffer(attachment.content)) {
                        attachment.content = attachment.content.toString('base64');
                        attachment.encoding = 'base64';
                    }
                });

            // 规范化头部
            data.normalizedHeaders = {};
            Object.keys(data.headers || {}).forEach(key => {
                let value = [].concat(data.headers[key] || []).shift();
                value = (value && value.value) || value;
                if (value) {
                    // 对特定头部进行编码
                    if (['references', 'in-reply-to', 'message-id', 'content-id'].includes(key))
                        value = this.message._encodeHeaderValue(key, value);

                    data.normalizedHeaders[key] = value;
                }
            });

            // 处理列表头部
            if (data.list && typeof data.list === 'object') {
                let listHeaders = this._getListHeaders(data.list);
                listHeaders.forEach(entry => {
                    data.normalizedHeaders[entry.key] = entry.value.map(val => (val && val.value) || val).join(', ');
                });
            }

            // 处理引用头部
            if (data.references)
                data.normalizedHeaders.references = this.message._encodeHeaderValue('references', data.references);

            // 处理回复头部
            if (data.inReplyTo)
                data.normalizedHeaders['in-reply-to'] = this.message._encodeHeaderValue('in-reply-to', data.inReplyTo);

            return callback(null, data); // 返回规范化后的数据
        });
    }

    // 设置邮件发送器头部
    setMailerHeader() {
        if (!this.message || !this.data.xMailer) return; // 如果没有消息或没有xMailer，则直接返回

        this.message.setHeader('X-Mailer', this.data.xMailer);
    }

    // 设置优先级头部
    setPriorityHeaders() {
        if (!this.message || !this.data.priority) return; // 如果没有消息或没有优先级，则直接返回

        switch ((this.data.priority || '').toString().toLowerCase()) {
            case 'high': // 高优先级
                this.message.setHeader('X-Priority', '1 (Highest)');
                this.message.setHeader('X-MSMail-Priority', 'High');
                this.message.setHeader('Importance', 'High');
                break;
            case 'low': // 低优先级
                this.message.setHeader('X-Priority', '5 (Lowest)');
                this.message.setHeader('X-MSMail-Priority', 'Low');
                this.message.setHeader('Importance', 'Low');
                break;
            default: // 默认不添加，因为所有消息默认都是"普通"优先级
        }
    }

    // 设置列表头部
    setListHeaders() {
        // 如果没有消息或没有列表头部，则直接返回
        if (!this.message || !this.data.list || typeof this.data.list !== 'object') return;

        // 添加可选的 List-* 头部
        if (this.data.list && typeof this.data.list === 'object')
            this._getListHeaders(this.data.list).forEach(listHeader => {
                listHeader.value.forEach(value => {
                    this.message.addHeader(listHeader.key, value);
                });
            });
    }

    // 获取列表头部
    _getListHeaders(listData) {
        // 确保URL格式为 <protocol:url>
        return Object.keys(listData).map(key => ({
            key: 'list-' + key.toLowerCase().trim(), // 列表头部键名
            value: [].concat(listData[key] || []).map(value => ({
                prepared: true,
                foldLines: true,
                value: []
                    .concat(value || [])
                    .map(value => {
                        if (typeof value === 'string') value = { url: value }; // 如果值是字符串，则转换为对象

                        if (value && value.url) {
                            if (key.toLowerCase().trim() === 'id') {
                                // List-ID: "comment" <domain>
                                let comment = value.comment || '';
                                // 如果是纯文本，则添加引号包裹,否则使用encodeWord
                                if (isPlainText(comment)) comment = '"' + comment + '"';
                                else comment = encodeWord(comment);
                                // 如果有注释，则添加注释，否则返回空字符串
                                return (value.comment ? comment + ' ' : '')
                                    + this._formatListUrl(value.url).replace(regexs.LIST_ID_PROTOCOL_REMOVE, '');
                            }

                            // List-*: <http://domain> (comment)
                            let comment = value.comment || '';
                            // 如果不是纯文本，则使用encodeWord
                            if (!isPlainText(comment)) comment = encodeWord(comment);
                            // 返回格式化后的URL和注释
                            return this._formatListUrl(value.url) + (value.comment ? ' (' + comment + ')' : '');
                        }

                        return '';
                    })
                    .filter(value => value)
                    .join(', ')
            }))
        }));
    }

    // 格式化列表URL
    _formatListUrl(url) {
        resetRegex(regexs.URL_CLEAN);
        url = url.replace(regexs.URL_CLEAN, ''); // 去除空白和尖括号
        if (regexs.PROTOCOL_CHECK.test(url)) return '<' + url + '>'; // 如果包含协议，则使用尖括号包裹

        if (regexs.EMAIL_CHECK.test(url)) return '<mailto:' + url + '>'; // 如果包含@，则使用mailto协议

        return '<http://' + url + '>'; // 默认使用HTTP协议
    }
}

// 导出 MailMessage 类
module.exports = MailMessage;