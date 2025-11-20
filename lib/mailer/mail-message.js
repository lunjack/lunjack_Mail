'use strict';

// 引入所需模块
const MimeNode = require('../mime-node');
const { regexs, resetRegex, resolveContent } = require('../shared');
const { detectExtension, detectMimeType, isPlainText, encodeWord } = require('../mime-funcs');

// 定义 MailMessage 类
class MailMessage {
    // 构造函数，初始化邮件消息对象
    constructor(mailer, data = {}) {
        this.mailer = mailer, this.message = null;
        const { options = {}, _defaults = {} } = mailer;
        this.data = this._buildMailData(data, _defaults, options); // 初始化所有数据
    }

    _buildMailData(data, defaults, options) {
        const headers = { ...defaults.headers, ...data.headers }, mailData = { ...defaults, ...data, headers };
        // 强制应用 transporter 选项中的特定键
        ['disableFileAccess', 'disableUrlAccess', 'normalizeHeaderKey'].forEach(key => {
            if (key in options) mailData[key] = options[key]; // 如果在选项中设置，则使用选项值
        });

        return mailData;
    }

    // 解析内容方法（代理给 resolveContent）
    resolveContent(...args) {
        return resolveContent(...args);
    }

    // 解析所有内容（文本、HTML、附件等）
    resolveAll(callback) {
        // 定义需要解析的内容键
        const keys = [
            [this.data, 'html'], [this.data, 'text'], [this.data, 'watchHtml'], [this.data, 'amp'], [this.data, 'icalEvent']
        ], { alternatives, attachments } = this.data;
        alternatives?.forEach((_, i) => keys.push([alternatives, i])); // 如果有替代内容，则添加到键中

        // 处理附件
        attachments?.forEach((attachment, i) => {
            const { filename, path, href = '', contentType } = attachment;
            let newFname = filename;
            // 如果没有文件名，则从路径或href中提取，或使用默认名称
            if (!newFname) {
                newFname = (path || href).split('/').pop().split('?').shift() || `attachment-${(i + 1)}`;
                if (!newFname.includes('.')) newFname += `.${detectExtension(contentType)}`; // 如果没有扩展名，则根据内容类型添加
                attachment.filename = newFname; // 设置回attachment对象
            }

            // 如果没有内容类型，则根据文件名、路径或href检测
            if (!contentType) attachment.contentType = detectMimeType(newFname || path || href || 'bin');
            keys.push([attachments, i]);
        });

        // 创建 MimeNode 实例用于地址解析和处理地址字段
        const mimeNode = new MimeNode(), addressKeys = ['from', 'to', 'cc', 'bcc', 'sender', 'replyTo'];

        addressKeys.forEach(address => {
            let value;
            const rAddress = this.message.getHeader(address === 'replyTo' ? 'reply-to' : address);
            // 如果已有消息，从消息头解析地址
            if (this.message) value = [].concat(mimeNode._parseAddresses(rAddress) || []);
            // 否则如果数据中有，则直接从数据中解析
            else if (this.data[address]) value = [].concat(mimeNode._parseAddresses(this.data[address]) || []);

            if (value?.length) this.data[address] = value;            // 如果有值，则保存到数据中
            else if (address in this.data) this.data[address] = null; // 否则如果数据中有地址字段，则删除地址字段
        });

        // 处理单值地址字段（from, sender）;如果数据中有地址，则保存为地址对象
        ['from', 'sender'].forEach(address => {
            if (this.data[address]) this.data[address] = this.data[address].shift();
        });

        // 递归解析所有内容
        let pos = 0;
        const resolveNext = () => {
            if (pos >= keys.length) return callback(null, this.data); // 所有内容解析完成

            const args = keys[pos++], parent = args[0], key = args[1], currentItem = parent[key]; // 父对象, 属性名, 当前项

            if (!parent || !currentItem) return resolveNext();       // 跳过空值
            resolveContent(...args, (err, value) => {
                if (err) return callback(err);
                const node = { content: value };// 创建内容节点，保留原始数据的其他属性
                if (currentItem && typeof currentItem === 'object' && !Buffer.isBuffer(currentItem))
                    Object.keys(currentItem).forEach(key => {
                        // 如果没有在节点中，则从原始数据中复制属性
                        if (!(key in node) && !['content', 'path', 'href', 'raw'].includes(key)) node[key] = currentItem[key];
                    });

                parent[key] = node, resolveNext(); // 更新数据为节点对象并继续解析下一个
            });
        };

        setImmediate(() => resolveNext()); // 使用 setImmediate 异步开始解析
    }

    // 规范化邮件数据
    normalize(callback) {
        const envelope = this.data.envelope || this.message.getEnvelope(), messageId = this.message.messageId(); // 获取信封信息
        // 首先解析所有内容
        this.resolveAll((err, data) => {
            if (err) return callback(err); // 如果解析失败，返回错误

            data.envelope = envelope, data.messageId = messageId; // 设置信封和消息ID
            ['html', 'text', 'watchHtml', 'amp'].forEach(key => {
                const content = data[key]?.content;
                // 如果内容不是是字符串，则转换为字符串,否则直接使用，
                if (content) data[key] = Buffer.isBuffer(content) ? content.toString() : content;
            });

            // 将Buffer转换为base64的通用函数
            const convertToBase64 = (item) => {
                const content = item?.content;
                if (Buffer.isBuffer(content)) item.content = content.toString('base64'), item.encoding = 'base64';
            };

            const { icalEvent, alternatives, attachments, headers = {}, list, references, inReplyTo } = data;
            // 处理日历事件,替代内容,附件
            if (icalEvent) convertToBase64(icalEvent);
            alternatives?.forEach(convertToBase64), attachments?.forEach(convertToBase64);

            // 规范化头部
            const normalizedHeaders = {};
            Object.keys(headers).forEach(key => {
                let value = [].concat(headers[key] || []).shift();
                value = value?.value ?? value;
                if (value != null) {
                    // 对特定头部进行编码
                    if (['references', 'in-reply-to', 'message-id', 'content-id'].includes(key))
                        value = this.message._encodeHeaderValue(key, value);
                    normalizedHeaders[key] = value;
                }
            });

            // 处理列表头部
            if (list && typeof list === 'object') {
                const listHeaders = this._getListHeaders(list);
                listHeaders.forEach(entry => {
                    normalizedHeaders[entry.key] = entry.value.map(val => val?.value ?? val).join(', ');
                });
            }

            // 处理引用头部和回复头部
            if (references) normalizedHeaders.references = this.message._encodeHeaderValue('references', references);
            if (inReplyTo) normalizedHeaders['in-reply-to'] = this.message._encodeHeaderValue('in-reply-to', inReplyTo);

            data.normalizedHeaders = normalizedHeaders;
            return callback(null, data); // 返回规范化后的数据
        });
    }

    // 设置邮件发送器头部
    setMailerHeader() {
        if (!this.message || !this.data.xMailer) return;        // 如果没有消息或没有xMailer，则直接返回
        this.message.setHeader('X-Mailer', this.data.xMailer);
    }

    // 设置优先级头部
    setPriorityHeaders() {
        if (!this.message || !this.data.priority) return;

        const configs = { high: ['1 (Highest)', 'High'], low: ['5 (Lowest)', 'Low'] },
            priority = this.data.priority.toString().toLowerCase(), config = configs[priority];
        if (config) {
            this.message.setHeader('X-Priority', config[0]), this.message.setHeader('X-MSMail-Priority', config[1]);
            this.message.setHeader('Importance', config[1].toLowerCase());
        }
    }

    // 设置列表头部
    setListHeaders() {
        const list = this.data.list;
        if (!this.message || !list || typeof list !== 'object') return; // 如果没有消息或没有列表头部，则直接返回

        // 添加可选的 List-* 头部
        if (list && typeof list === 'object')
            this._getListHeaders(list).forEach(listHeader => {
                listHeader.value.forEach(value => this.message.addHeader(listHeader.key, value));
            });
    }

    // 获取列表头部
    _getListHeaders(listData) {
        return Object.entries(listData).map(([key, values = []]) => [key.toLowerCase().trim(), values])
            .map(([processedKey, values]) => ({
                key: `list-${processedKey}`,
                value: [{
                    prepared: true, foldLines: true,
                    value: [].concat(values)
                        .map(val => typeof val === 'string' ? { url: val } : val).filter(val => val?.url)
                        .map(val => {
                            const isId = processedKey === 'id';
                            let comment = val.comment;
                            comment = comment ? (!isPlainText(comment) ? encodeWord(comment) : comment) : '';
                            const formattedUrl = this._formatListUrl(val.url); // 格式化URL

                            if (isId) {
                                const quotedComment = comment ? `"${comment}" ` : '',
                                    url = formattedUrl.replace(regexs.LIST_ID_PROTOCOL_REMOVE, '');
                                return quotedComment + url; // List-ID: "comment" <domain>
                            }
                            // 返回格式化后的URL和注释（List-*: <http://domain> (comment)）
                            return comment ? `${formattedUrl} (${comment})` : formattedUrl;
                        }).join(', ')
                }]
            }));
    }

    // 格式化列表URL
    _formatListUrl(url) {
        const rUC = resetRegex(regexs.URL_CLEAN);
        url = url.replace(rUC, '');                               // 去除空白和尖括号
        if (regexs.PROTOCOL_CHECK.test(url)) return `<${url}>`;   // 如果包含协议，则使用尖括号包裹
        // 如果包含@，则使用mailto协议,否则使用HTTP协议
        return regexs.EMAIL_CHECK.test(url) ? `<mailto:${url}>` : `<http://${url}>`;
    }
}

// 导出
module.exports = MailMessage;