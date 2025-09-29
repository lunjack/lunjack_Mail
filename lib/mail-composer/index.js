/* eslint no-undefined: 0 */

'use strict';

const MimeNode = require('../mime-node');
const mimeFuncs = require('../mime-funcs');
const parseDataURI = require('../shared').parseDataURI;

/**
 * 创建用于从邮件选项组合MimeNode实例的对象
 *
 * @constructor
 * @param {Object} mail 邮件选项
 */
class MailComposer {
    constructor(mail) {
        this.mail = mail || {};
        this.message = false;
    }

    /**
     * 构建MimeNode实例
     */
    compile() {
        // 分析替代项和附件
        this._alternatives = this.getAlternatives();
        // 优先选择最后一个HTML节点作为主要HTML节点
        this._htmlNode = this._alternatives.filter(alternative => /^text\/html\b/i.test(alternative.contentType)).pop();
        // 如果没有HTML节点，则不使用相关附件
        this._attachments = this.getAttachments(!!this._htmlNode);
        // 确定MIME树的结构
        this._useRelated = !!(this._htmlNode && this._attachments.related.length);
        this._useAlternative = this._alternatives.length > 1; // 或者有一个HTML节点和相关附件
        // 确定是否使用混合内容
        this._useMixed = this._attachments.attached.length > 1 || (this._alternatives.length && this._attachments.attached.length === 1);

        // 组合MIME树
        if (this.mail.raw) this.message = new MimeNode('message/rfc822', { newline: this.mail.newline }).setRaw(this.mail.raw);
        else if (this._useMixed) this.message = this._createMixed();
        else if (this._useAlternative) this.message = this._createAlternative();
        else if (this._useRelated) this.message = this._createRelated();
        else {
            this.message = this._createContentNode(
                false,
                []
                    .concat(this._alternatives || [])
                    .concat(this._attachments.attached || [])
                    .shift() || {
                    contentType: 'text/plain',
                    content: ''
                }
            );
        }

        // 添加自定义头部(如果有)
        if (this.mail.headers) this.message.addHeader(this.mail.headers);

        // 向根节点添加头部，始终覆盖自定义头部
        ['from', 'sender', 'to', 'cc', 'bcc', 'reply-to', 'in-reply-to', 'references', 'subject', 'message-id', 'date'].forEach(header => {
            let key = header.replace(/-(\w)/g, (o, c) => c.toUpperCase());
            if (this.mail[key]) this.message.setHeader(header, this.mail[key]); // 覆盖任何自定义头部(如果存在)
        });

        // 设置自定义信封(如果有)
        if (this.mail.envelope) this.message.setEnvelope(this.mail.envelope);

        // 确保Message-Id值存在
        this.message.messageId();

        return this.message;
    }

    /**
     * 列出所有附件。生成的附件对象可用作MimeNode节点的输入
     *
     * @param {Boolean} findRelated 如果为true，则将相关附件与附加附件分开
     * @returns {Object} 包含数组的对象（`related`和`attached`）
     */
    getAttachments(findRelated) {
        let icalEvent, eventObject;
        let attachments = [].concat(this.mail.attachments || []).map((attachment, i) => {
            let data;
            // 如果是数据URI，则将其转换为Buffer
            if (/^data:/i.test(attachment.path || attachment.href)) attachment = this._processDataUrl(attachment);

            let contentType = attachment.contentType || mimeFuncs.detectMimeType(attachment.filename || attachment.path || attachment.href || 'bin');

            let isImage = /^image\//i.test(contentType);
            let isMessageNode = /^message\//i.test(contentType);

            let contentDisposition = attachment.contentDisposition || (isMessageNode || (isImage && attachment.cid) ? 'inline' : 'attachment');

            let contentTransferEncoding;
            // 优先使用用户定义的值(如果存在)
            if ('contentTransferEncoding' in attachment) contentTransferEncoding = attachment.contentTransferEncoding;
            else if (isMessageNode) contentTransferEncoding = '7bit'; // message节点必须是7bit
            else contentTransferEncoding = 'base64'; // 默认值

            data = {
                contentType,
                contentDisposition,
                contentTransferEncoding
            };

            if (attachment.filename) data.filename = attachment.filename; // 用户定义的文件名(如果存在)
            // 如果未禁用且未设置为false，则自动生成文件名
            else if (!isMessageNode && attachment.filename !== false) {
                data.filename = (attachment.path || attachment.href || '').split('/').pop().split('?').shift() || 'attachment-' + (i + 1);
                if (data.filename.indexOf('.') < 0) data.filename += '.' + mimeFuncs.detectExtension(data.contentType);
            }
            // 如果是URL，则将其转换为href
            if (/^https?:\/\//i.test(attachment.path)) {
                attachment.href = attachment.path;
                attachment.path = undefined;
            }

            if (attachment.cid) data.cid = attachment.cid; // 用户定义的CID(如果存在)

            if (attachment.raw) data.raw = attachment.raw; // 预生成的原始内容(如果存在)
            // 优先使用预定义的内容(如果存在)
            else if (attachment.path) {
                data.content = {
                    path: attachment.path
                };
            }
            // 其次使用URL内容(如果存在)
            else if (attachment.href) {
                data.content = {
                    href: attachment.href,
                    httpHeaders: attachment.httpHeaders
                };
            }
            // 最后使用提供的内容(如果存在)
            else data.content = attachment.content || '';

            if (attachment.encoding) data.encoding = attachment.encoding; // 用户定义的内容编码(如果存在)
            if (attachment.headers) data.headers = attachment.headers; // 用户定义的头部(如果存在)

            return data;
        });

        if (this.mail.icalEvent) {
            // 如果是对象并且至少有一个属性,则假定它是一个附件对象
            if (
                typeof this.mail.icalEvent === 'object' &&
                (this.mail.icalEvent.content || this.mail.icalEvent.path || this.mail.icalEvent.href || this.mail.icalEvent.raw)
            ) icalEvent = this.mail.icalEvent;
            // 否则将其视为文本内容
            else {
                icalEvent = {
                    content: this.mail.icalEvent
                };
            }

            eventObject = {};
            Object.keys(icalEvent).forEach(key => {
                eventObject[key] = icalEvent[key];
            });

            eventObject.contentType = 'application/ics';
            if (!eventObject.headers) eventObject.headers = {}; // 如果不存在，则创建头部对象
            eventObject.filename = eventObject.filename || 'invite.ics';
            eventObject.headers['Content-Disposition'] = 'attachment';
            eventObject.headers['Content-Transfer-Encoding'] = 'base64';
        }

        // 如果不查找相关附件，则将所有内容作为附加内容返回
        if (!findRelated) {
            return {
                attached: attachments.concat(eventObject || []),
                related: []
            };
        }
        // 否则将内容分为相关和附加两部分
        else {
            return {
                attached: attachments.filter(attachment => !attachment.cid).concat(eventObject || []),
                related: attachments.filter(attachment => !!attachment.cid)
            };
        }
    }

    /**
     * 列出替代项。生成的对象可用作MimeNode节点的输入
     *
     * @returns {Array} 替代元素的数组。包括`text`和`html`值
     */
    getAlternatives() {
        let alternatives = [],
            text,
            html,
            watchHtml,
            amp,
            icalEvent,
            eventObject;

        if (this.mail.text) {
            if (typeof this.mail.text === 'object' && (this.mail.text.content || this.mail.text.path || this.mail.text.href || this.mail.text.raw))
                text = this.mail.text; // 如果是对象并且至少有一个属性,则假定它是一个附件对象
            // 否则将其视为文本内容
            else {
                text = {
                    content: this.mail.text
                };
            }
            text.contentType = 'text/plain; charset=utf-8';
        }

        if (this.mail.watchHtml) {
            if (
                typeof this.mail.watchHtml === 'object' &&
                (this.mail.watchHtml.content || this.mail.watchHtml.path || this.mail.watchHtml.href || this.mail.watchHtml.raw)
            ) watchHtml = this.mail.watchHtml; // 如果是对象并且至少有一个属性,则假定它是一个附件对象
            // 否则将其视为文本内容
            else {
                watchHtml = {
                    content: this.mail.watchHtml
                };
            }
            watchHtml.contentType = 'text/watch-html; charset=utf-8';
        }

        if (this.mail.amp) {
            if (typeof this.mail.amp === 'object' && (this.mail.amp.content || this.mail.amp.path || this.mail.amp.href || this.mail.amp.raw))
                amp = this.mail.amp; // 如果是对象并且至少有一个属性,则假定它是一个附件对象
            // 否则将其视为文本内容
            else {
                amp = {
                    content: this.mail.amp
                };
            }
            amp.contentType = 'text/x-amp-html; charset=utf-8';
        }

        // 注意！当包含带有日历替代项的附件时，某些客户端可能会出现空白屏幕
        if (this.mail.icalEvent) {
            if (
                typeof this.mail.icalEvent === 'object' &&
                (this.mail.icalEvent.content || this.mail.icalEvent.path || this.mail.icalEvent.href || this.mail.icalEvent.raw)
            ) icalEvent = this.mail.icalEvent; // 如果是对象并且至少有一个属性,则假定它是一个附件对象
            // 否则将其视为文本内容
            else {
                icalEvent = {
                    content: this.mail.icalEvent
                };
            }

            eventObject = {};
            Object.keys(icalEvent).forEach(key => {
                eventObject[key] = icalEvent[key];
            });

            if (eventObject.content && typeof eventObject.content === 'object') eventObject.content._resolve = true;

            eventObject.filename = false;
            eventObject.contentType = 'text/calendar; charset=utf-8; method=' + (eventObject.method || 'PUBLISH').toString().trim().toUpperCase();
            if (!eventObject.headers) eventObject.headers = {};
        }

        if (this.mail.html) {
            if (typeof this.mail.html === 'object' && (this.mail.html.content || this.mail.html.path || this.mail.html.href || this.mail.html.raw))
                html = this.mail.html;
            else {
                html = {
                    content: this.mail.html
                };
            }
            html.contentType = 'text/html; charset=utf-8';
        }

        []
            .concat(text || [])
            .concat(watchHtml || [])
            .concat(amp || [])
            .concat(html || [])
            .concat(eventObject || [])
            .concat(this.mail.alternatives || [])
            .forEach(alternative => {
                let data;

                if (/^data:/i.test(alternative.path || alternative.href)) {
                    alternative = this._processDataUrl(alternative);
                }

                data = {
                    contentType: alternative.contentType || mimeFuncs.detectMimeType(alternative.filename || alternative.path || alternative.href || 'txt'),
                    contentTransferEncoding: alternative.contentTransferEncoding
                };

                if (alternative.filename) {
                    data.filename = alternative.filename;
                }

                if (/^https?:\/\//i.test(alternative.path)) {
                    alternative.href = alternative.path;
                    alternative.path = undefined;
                }

                if (alternative.raw) {
                    data.raw = alternative.raw;
                } else if (alternative.path) {
                    data.content = {
                        path: alternative.path
                    };
                } else if (alternative.href) {
                    data.content = {
                        href: alternative.href
                    };
                } else {
                    data.content = alternative.content || '';
                }

                if (alternative.encoding) {
                    data.encoding = alternative.encoding;
                }

                if (alternative.headers) {
                    data.headers = alternative.headers;
                }

                alternatives.push(data);
            });

        return alternatives;
    }

    /**
     * 构建multipart/mixed节点。它应始终包含同一级别的不同类型元素
     * 例如：文本 + 附件
     *
     * @param {Object} parentNode 此节点的父节点。如果不存在，则创建根节点
     * @returns {Object} MimeNode节点元素
     */
    _createMixed(parentNode) {
        let node;

        if (!parentNode) {
            node = new MimeNode('multipart/mixed', {
                baseBoundary: this.mail.baseBoundary,
                textEncoding: this.mail.textEncoding,
                boundaryPrefix: this.mail.boundaryPrefix,
                disableUrlAccess: this.mail.disableUrlAccess,
                disableFileAccess: this.mail.disableFileAccess,
                normalizeHeaderKey: this.mail.normalizeHeaderKey,
                newline: this.mail.newline
            });
        } else {
            node = parentNode.createChild('multipart/mixed', {
                disableUrlAccess: this.mail.disableUrlAccess,
                disableFileAccess: this.mail.disableFileAccess,
                normalizeHeaderKey: this.mail.normalizeHeaderKey,
                newline: this.mail.newline
            });
        }

        if (this._useAlternative) {
            this._createAlternative(node);
        } else if (this._useRelated) {
            this._createRelated(node);
        }

        []
            .concat((!this._useAlternative && this._alternatives) || [])
            .concat(this._attachments.attached || [])
            .forEach(element => {
                // 如果元素来自相关子部分的html节点，则忽略它
                if (!this._useRelated || element !== this._htmlNode) {
                    this._createContentNode(node, element);
                }
            });

        return node;
    }

    /**
     * 构建multipart/alternative节点。它应始终包含同一级别的相同类型元素
     * 例如：相同数据的文本和html视图
     *
     * @param {Object} parentNode 此节点的父节点。如果不存在，则创建根节点
     * @returns {Object} MimeNode节点元素
     */
    _createAlternative(parentNode) {
        let node;

        if (!parentNode) {
            node = new MimeNode('multipart/alternative', {
                baseBoundary: this.mail.baseBoundary,
                textEncoding: this.mail.textEncoding,
                boundaryPrefix: this.mail.boundaryPrefix,
                disableUrlAccess: this.mail.disableUrlAccess,
                disableFileAccess: this.mail.disableFileAccess,
                normalizeHeaderKey: this.mail.normalizeHeaderKey,
                newline: this.mail.newline
            });
        } else {
            node = parentNode.createChild('multipart/alternative', {
                disableUrlAccess: this.mail.disableUrlAccess,
                disableFileAccess: this.mail.disableFileAccess,
                normalizeHeaderKey: this.mail.normalizeHeaderKey,
                newline: this.mail.newline
            });
        }

        this._alternatives.forEach(alternative => {
            if (this._useRelated && this._htmlNode === alternative) {
                this._createRelated(node);
            } else {
                this._createContentNode(node, alternative);
            }
        });

        return node;
    }

    /**
     * 构建multipart/related节点。它应始终包含带有相关附件的html节点
     *
     * @param {Object} parentNode 此节点的父节点。如果不存在，则创建根节点
     * @returns {Object} MimeNode节点元素
     */
    _createRelated(parentNode) {
        let node;

        if (!parentNode) {
            node = new MimeNode('multipart/related; type="text/html"', {
                baseBoundary: this.mail.baseBoundary,
                textEncoding: this.mail.textEncoding,
                boundaryPrefix: this.mail.boundaryPrefix,
                disableUrlAccess: this.mail.disableUrlAccess,
                disableFileAccess: this.mail.disableFileAccess,
                normalizeHeaderKey: this.mail.normalizeHeaderKey,
                newline: this.mail.newline
            });
        } else {
            node = parentNode.createChild('multipart/related; type="text/html"', {
                disableUrlAccess: this.mail.disableUrlAccess,
                disableFileAccess: this.mail.disableFileAccess,
                normalizeHeaderKey: this.mail.normalizeHeaderKey,
                newline: this.mail.newline
            });
        }

        this._createContentNode(node, this._htmlNode);

        this._attachments.related.forEach(alternative => this._createContentNode(node, alternative));

        return node;
    }

    /**
     * 创建带有内容的常规节点
     *
     * @param {Object} parentNode 此节点的父节点。如果不存在，则创建根节点
     * @param {Object} element 节点数据
     * @returns {Object} MimeNode节点元素
     */
    _createContentNode(parentNode, element) {
        element = element || {};
        element.content = element.content || '';

        let node;
        let encoding = (element.encoding || 'utf8')
            .toString()
            .toLowerCase()
            .replace(/[-_\s]/g, '');

        if (!parentNode) {
            node = new MimeNode(element.contentType, {
                filename: element.filename,
                baseBoundary: this.mail.baseBoundary,
                textEncoding: this.mail.textEncoding,
                boundaryPrefix: this.mail.boundaryPrefix,
                disableUrlAccess: this.mail.disableUrlAccess,
                disableFileAccess: this.mail.disableFileAccess,
                normalizeHeaderKey: this.mail.normalizeHeaderKey,
                newline: this.mail.newline
            });
        } else {
            node = parentNode.createChild(element.contentType, {
                filename: element.filename,
                textEncoding: this.mail.textEncoding,
                disableUrlAccess: this.mail.disableUrlAccess,
                disableFileAccess: this.mail.disableFileAccess,
                normalizeHeaderKey: this.mail.normalizeHeaderKey,
                newline: this.mail.newline
            });
        }

        // 添加自定义头部
        if (element.headers) {
            node.addHeader(element.headers);
        }

        if (element.cid) {
            node.setHeader('Content-Id', '<' + element.cid.replace(/[<>]/g, '') + '>');
        }

        if (element.contentTransferEncoding) {
            node.setHeader('Content-Transfer-Encoding', element.contentTransferEncoding);
        } else if (this.mail.encoding && /^text\//i.test(element.contentType)) {
            node.setHeader('Content-Transfer-Encoding', this.mail.encoding);
        }

        if (!/^text\//i.test(element.contentType) || element.contentDisposition) {
            node.setHeader(
                'Content-Disposition',
                element.contentDisposition || (element.cid && /^image\//i.test(element.contentType) ? 'inline' : 'attachment')
            );
        }

        if (typeof element.content === 'string' && !['utf8', 'usascii', 'ascii'].includes(encoding)) {
            element.content = Buffer.from(element.content, encoding);
        }

        // 优先使用预生成的原始内容
        if (element.raw) {
            node.setRaw(element.raw);
        } else {
            node.setContent(element.content);
        }

        return node;
    }

    /**
     * 解析数据URI并将其转换为Buffer
     *
     * @param {Object} element 内容元素
     * @return {Object} 解析后的元素
     */
    _processDataUrl(element) {
        const dataUrl = element.path || element.href;

        // 早期验证以防止ReDoS攻击
        if (!dataUrl || typeof dataUrl !== 'string') {
            return element;
        }

        if (!dataUrl.startsWith('data:')) {
            return element;
        }

        if (dataUrl.length > 100000) {
            // 数据URL字符串限制为100KB
            // 对于过长的数据URL返回空内容
            return Object.assign({}, element, {
                path: false,
                href: false,
                content: Buffer.alloc(0),
                contentType: element.contentType || 'application/octet-stream'
            });
        }

        let parsedDataUri;
        try {
            parsedDataUri = parseDataURI(dataUrl);
        } catch (err) {
            return element;
        }

        if (!parsedDataUri) {
            return element;
        }

        element.content = parsedDataUri.data;
        element.contentType = element.contentType || parsedDataUri.contentType;

        if ('path' in element) {
            element.path = false;
        }

        if ('href' in element) {
            element.href = false;
        }

        return element;
    }
}

module.exports = MailComposer;