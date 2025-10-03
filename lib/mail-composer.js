/* eslint no-undefined: 0 */

'use strict';

const MimeNode = require('./mime-node');
const { detectMimeType, detectExtension } = require('./mime-funcs');
const { parseDataURI } = require('./shared');

/**
 * 邮件编译器类，用于从邮件选项组合MimeNode实例
 * 负责处理邮件的多部分结构（纯文本、HTML、附件等）
 * @class MailComposer
 */
class MailComposer {
    /**
     * 创建MailComposer实例
     * @constructor
     * @param {Object} mail - 邮件配置对象
     */
    constructor(mail) {
        this.mail = mail || {};
        this.message = false;
    }

    /**
     * 编译邮件内容，生成MimeNode实例
     * 根据邮件内容类型（纯文本、HTML、附件等）构建相应的MIME结构
     * @returns {MimeNode} 编译后的MimeNode实例
     */
    compile() {
        // 获取所有替代内容（纯文本、HTML、日历事件等）
        this._alternatives = this.getAlternatives();
        // 从替代内容中提取HTML节点
        this._htmlNode = this._alternatives.filter(alternative => /^text\/html\b/i.test(alternative.contentType)).pop();
        // 获取附件，并根据是否存在HTML内容区分相关附件
        this._attachments = this.getAttachments(!!this._htmlNode);

        // 确定需要使用的MIME类型结构
        this._useRelated = !!(this._htmlNode && this._attachments.related.length); // 是否需要相关部分（HTML + 内联图片）
        this._useAlternative = this._alternatives.length > 1; // 是否需要替代部分（纯文本 + HTML）
        this._useMixed = this._attachments.attached.length > 1 // 是否需要混合部分（内容 + 附件）
            || (this._alternatives.length && this._attachments.attached.length === 1);

        // 根据内容类型构建相应的MIME结构
        if (this.mail.raw)  // 如果有raw字段，则直接使用raw字段
            this.message = new MimeNode('message/rfc822', { newline: this.mail.newline }).setRaw(this.mail.raw);
        else if (this._useMixed) this.message = this._createMixed(); // 混合类型：内容 + 多个附件
        else if (this._useAlternative) this.message = this._createAlternative(); // 替代类型：纯文本 + HTML
        else if (this._useRelated) this.message = this._createRelated(); // 相关类型：HTML + 内联资源
        else
            // 简单类型：单一内容
            this.message = this._createContentNode(
                false,
                [].concat(this._alternatives || [])
                    .concat(this._attachments.attached || [])
                    .shift() || {
                    contentType: 'text/plain',
                    content: ''
                }
            );

        // 添加自定义邮件头
        if (this.mail.headers) this.message.addHeader(this.mail.headers);

        // 设置标准邮件头
        ['from', 'sender', 'to', 'cc', 'bcc', 'reply-to', 'in-reply-to', 'references', 'subject', 'message-id', 'date']
            .forEach(header => {
                let key = header.replace(/-(\w)/g, (o, c) => c.toUpperCase());
                if (this.mail[key]) this.message.setHeader(header, this.mail[key]);
            });

        // 设置邮件信封和消息ID
        if (this.mail.envelope) this.message.setEnvelope(this.mail.envelope);
        this.message.messageId();

        return this.message;
    }

    /**
     * 获取邮件附件列表
     * 处理普通附件和相关附件（如内联图片）
     * @param {boolean} findRelated - 是否查找相关附件（用于HTML内联）
     * @returns {Object} 包含attached和related附件的对象
     */
    getAttachments(findRelated) {
        let icalEvent, eventObject;
        // 处理所有附件
        let attachments = [].concat(this.mail.attachments || []).map((attachment, i) => {
            // 处理dataURL格式的附件
            if (/^data:/i.test(attachment.path || attachment.href)) attachment = this._processDataUrl(attachment);

            // 检测内容类型
            let contentType = attachment.contentType || detectMimeType(attachment.filename || attachment.path
                || attachment.href || 'bin');
            let isImage = /^image\//i.test(contentType);
            let isMessageNode = /^message\//i.test(contentType);
            // 确定内容处置方式：内联或附件
            let contentDisposition = attachment.contentDisposition || (isMessageNode || (isImage && attachment.cid)
                ? 'inline' : 'attachment');

            // 确定内容传输编码
            let contentTransferEncoding;
            if ('contentTransferEncoding' in attachment) contentTransferEncoding = attachment.contentTransferEncoding;
            else if (isMessageNode) contentTransferEncoding = '7bit';
            else contentTransferEncoding = 'base64';

            let data = { contentType, contentDisposition, contentTransferEncoding };

            // 处理文件名
            if (attachment.filename) data.filename = attachment.filename;
            else if (!isMessageNode && attachment.filename !== false) {
                data.filename = (attachment.path || attachment.href || '').split('/').pop().split('?').shift()
                    || 'attachment-' + (i + 1);
                if (data.filename.indexOf('.') < 0) data.filename += '.' + detectExtension(data.contentType);
            }

            // 标准化附件路径
            this._normalizeAttachmentPaths(attachment);

            // 设置附件内容标识和内容源
            if (attachment.cid) data.cid = attachment.cid;
            if (attachment.raw) data.raw = attachment.raw;
            else if (attachment.path) data.content = { path: attachment.path };
            else if (attachment.href) data.content = { href: attachment.href, httpHeaders: attachment.httpHeaders };
            else data.content = attachment.content || '';

            // 设置编码和自定义头
            if (attachment.encoding) data.encoding = attachment.encoding;
            if (attachment.headers) data.headers = attachment.headers;

            return data;
        });

        // 处理日历事件附件
        if (this.mail.icalEvent) {
            if (typeof this.mail.icalEvent === 'object' && (this.mail.icalEvent.content || this.mail.icalEvent.path
                || this.mail.icalEvent.href || this.mail.icalEvent.raw)) icalEvent = this.mail.icalEvent;
            else icalEvent = { content: this.mail.icalEvent };

            eventObject = Object.assign({}, icalEvent);
            eventObject.contentType = 'application/ics';
            eventObject.headers = eventObject.headers || {};
            eventObject.filename = eventObject.filename || 'invite.ics';
            eventObject.headers['Content-Disposition'] = 'attachment';
            eventObject.headers['Content-Transfer-Encoding'] = 'base64';
        }

        // 根据是否需要查找相关附件返回不同的结构
        if (!findRelated)
            return {
                attached: attachments.concat(eventObject || []), // 所有附件都是普通附件
                related: []
            };
        else
            return {
                attached: attachments.filter(attachment => !attachment.cid).concat(eventObject || []), // 无CID的为普通附件
                related: attachments.filter(attachment => !!attachment.cid) // 有CID的为相关附件（内联）
            };
    }

    /**
     * 获取邮件的替代内容（纯文本、HTML、日历事件等）
     * 用于构建多部分替代结构
     * @returns {Array} 替代内容数组
     */
    getAlternatives() {
        let alternatives = [], text, html, watchHtml, amp, icalEvent, eventObject;

        // 处理纯文本内容
        if (this.mail.text) {
            if (typeof this.mail.text === 'object' && (this.mail.text.content || this.mail.text.path || this.mail.text.href
                || this.mail.text.raw)) text = this.mail.text;
            else text = { content: this.mail.text };
            text.contentType = 'text/plain; charset=utf-8';
        }

        // 处理Apple Watch HTML内容
        if (this.mail.watchHtml) {
            if (typeof this.mail.watchHtml === 'object' && (this.mail.watchHtml.content || this.mail.watchHtml.path
                || this.mail.watchHtml.href || this.mail.watchHtml.raw)) watchHtml = this.mail.watchHtml;
            else watchHtml = { content: this.mail.watchHtml };
            watchHtml.contentType = 'text/watch-html; charset=utf-8';
        }

        // 处理AMP HTML内容
        if (this.mail.amp) {
            if (typeof this.mail.amp === 'object' && (this.mail.amp.content || this.mail.amp.path || this.mail.amp.href
                || this.mail.amp.raw)) amp = this.mail.amp;
            else amp = { content: this.mail.amp };
            amp.contentType = 'text/x-amp-html; charset=utf-8';
        }

        // 处理日历事件
        if (this.mail.icalEvent) {
            if (typeof this.mail.icalEvent === 'object' && (this.mail.icalEvent.content || this.mail.icalEvent.path
                || this.mail.icalEvent.href || this.mail.icalEvent.raw)) icalEvent = this.mail.icalEvent;
            else icalEvent = { content: this.mail.icalEvent };

            eventObject = Object.assign({}, icalEvent);
            if (eventObject.content && typeof eventObject.content === 'object') eventObject.content._resolve = true;
            eventObject.filename = false;
            eventObject.contentType = 'text/calendar; charset=utf-8; method=' + (eventObject.method
                || 'PUBLISH').toString().trim().toUpperCase();
            eventObject.headers = eventObject.headers || {};
        }

        // 处理HTML内容
        if (this.mail.html) {
            if (typeof this.mail.html === 'object' && (this.mail.html.content || this.mail.html.path || this.mail.html.href
                || this.mail.html.raw)) html = this.mail.html;
            else html = { content: this.mail.html };
            html.contentType = 'text/html; charset=utf-8';
        }

        // 将所有替代内容合并到数组中
        [].concat(text || []).concat(watchHtml || []).concat(amp || []).concat(html || []).concat(eventObject
            || []).concat(this.mail.alternatives || [])
            .forEach(alternative => {
                // 处理dataURL格式的内容
                if (/^data:/i.test(alternative.path || alternative.href)) alternative = this._processDataUrl(alternative);

                let data = {
                    contentType: alternative.contentType || detectMimeType(alternative.filename || alternative.path
                        || alternative.href || 'txt'),
                    contentTransferEncoding: alternative.contentTransferEncoding
                };

                // 设置文件名
                if (alternative.filename) data.filename = alternative.filename;
                // 标准化路径
                this._normalizeAttachmentPaths(alternative);

                // 设置内容源
                if (alternative.raw) data.raw = alternative.raw;
                else if (alternative.path) data.content = { path: alternative.path };
                else if (alternative.href) data.content = { href: alternative.href };
                else data.content = alternative.content || '';

                // 设置编码和自定义头
                if (alternative.encoding) data.encoding = alternative.encoding;
                if (alternative.headers) data.headers = alternative.headers;

                alternatives.push(data);
            });

        return alternatives;
    }

    /**
     * 创建混合类型的MIME节点（内容 + 附件）
     * @param {MimeNode} parentNode - 父节点
     * @returns {MimeNode} 创建的混合节点
     */
    _createMixed(parentNode) {
        let node;
        if (!parentNode) node = this._createRootMimeNode('multipart/mixed');
        else node = parentNode.createChild('multipart/mixed', this._getChildNodeOptions());

        // 根据内容类型添加子节点
        if (this._useAlternative) this._createAlternative(node);
        else if (this._useRelated) this._createRelated(node);

        // 添加所有替代内容和附件
        [].concat((!this._useAlternative && this._alternatives) || []).concat(this._attachments.attached || [])
            .forEach(element => {
                if (!this._useRelated || element !== this._htmlNode) this._createContentNode(node, element);
            });

        return node;
    }

    /**
     * 创建替代类型的MIME节点（纯文本 + HTML）
     * @param {MimeNode} parentNode - 父节点
     * @returns {MimeNode} 创建的替代节点
     */
    _createAlternative(parentNode) {
        let node;
        if (!parentNode) node = this._createRootMimeNode('multipart/alternative');
        else node = parentNode.createChild('multipart/alternative', this._getChildNodeOptions());

        // 添加所有替代内容
        this._alternatives.forEach(alternative => {
            if (this._useRelated && this._htmlNode === alternative) this._createRelated(node);
            else this._createContentNode(node, alternative);
        });

        return node;
    }

    /**
     * 创建相关类型的MIME节点（HTML + 内联资源）
     * @param {MimeNode} parentNode - 父节点
     * @returns {MimeNode} 创建的相关节点
     */
    _createRelated(parentNode) {
        let node;
        if (!parentNode) node = this._createRootMimeNode('multipart/related; type="text/html"');
        else node = parentNode.createChild('multipart/related; type="text/html"', this._getChildNodeOptions());

        // 添加HTML内容和相关附件
        this._createContentNode(node, this._htmlNode);
        this._attachments.related.forEach(alternative => this._createContentNode(node, alternative));
        return node;
    }

    /**
     * 创建内容节点
     * @param {MimeNode} parentNode - 父节点
     * @param {Object} element - 内容元素
     * @returns {MimeNode} 创建的内容节点
     */
    _createContentNode(parentNode, element) {
        element = element || {};
        element.content = element.content || '';

        let node;
        let encoding = (element.encoding || 'utf8').toString().toLowerCase().replace(/[-_\s]/g, '');

        // 创建节点（根节点或子节点）
        if (!parentNode)
            node = new MimeNode(element.contentType, {
                filename: element.filename, baseBoundary: this.mail.baseBoundary, textEncoding: this.mail.textEncoding,
                boundaryPrefix: this.mail.boundaryPrefix,
                disableUrlAccess: this.mail.disableUrlAccess, disableFileAccess: this.mail.disableFileAccess,
                normalizeHeaderKey: this.mail.normalizeHeaderKey, newline: this.mail.newline
            });
        else
            node = parentNode.createChild(element.contentType, {
                filename: element.filename, textEncoding: this.mail.textEncoding,
                disableUrlAccess: this.mail.disableUrlAccess, disableFileAccess: this.mail.disableFileAccess,
                normalizeHeaderKey: this.mail.normalizeHeaderKey, newline: this.mail.newline
            });

        // 设置节点头信息
        if (element.headers) node.addHeader(element.headers);
        if (element.cid) node.setHeader('Content-Id', '<' + element.cid.replace(/[<>]/g, '') + '>');
        if (element.contentTransferEncoding) node.setHeader('Content-Transfer-Encoding', element.contentTransferEncoding);
        else if (this.mail.encoding && /^text\//i.test(element.contentType))
            node.setHeader('Content-Transfer-Encoding', this.mail.encoding);

        // 设置内容处置方式
        if (!/^text\//i.test(element.contentType) || element.contentDisposition)
            node.setHeader('Content-Disposition', element.contentDisposition
                || (element.cid && /^image\//i.test(element.contentType) ? 'inline' : 'attachment'));

        // 处理内容编码
        if (typeof element.content === 'string' && !['utf8', 'usascii', 'ascii'].includes(encoding))
            element.content = Buffer.from(element.content, encoding);

        // 设置节点内容
        if (element.raw) node.setRaw(element.raw);
        else node.setContent(element.content);

        return node;
    }

    /**
     * 处理DataURL格式的内容
     * 将DataURL转换为二进制内容
     * @param {Object} element - 包含DataURL的元素
     * @returns {Object} 处理后的元素
     */
    _processDataUrl(element) {
        const dataUrl = element.path || element.href;
        if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return element;

        // 对过大的DataURL进行限制
        if (dataUrl.length > 100000)
            return Object.assign({}, element, {
                path: false, href: false, content: Buffer.alloc(0), contentType: element.contentType || 'application/octet-stream'
            });

        let parsedDataUri;
        try {
            parsedDataUri = parseDataURI(dataUrl);
        } catch (err) {
            return element;
        }

        if (!parsedDataUri) return element;

        // 替换DataURL为解析后的内容
        element.content = parsedDataUri.data;
        element.contentType = element.contentType || parsedDataUri.contentType;
        if ('path' in element) element.path = false;
        if ('href' in element) element.href = false;

        return element;
    }

    /**
     * 标准化附件路径
     * 将HTTP/HTTPS路径转换为href属性
     * @param {Object} attachment - 附件对象
     */
    _normalizeAttachmentPaths(attachment) {
        if (/^https?:\/\//i.test(attachment.path)) {
            attachment.href = attachment.path;
            attachment.path = undefined;
        }
    }

    /**
     * 创建根MIME节点
     * @param {string} contentType - 内容类型
     * @returns {MimeNode} 创建的根节点
     */
    _createRootMimeNode(contentType) {
        return new MimeNode(contentType, {
            baseBoundary: this.mail.baseBoundary,
            textEncoding: this.mail.textEncoding,
            boundaryPrefix: this.mail.boundaryPrefix,
            disableUrlAccess: this.mail.disableUrlAccess,
            disableFileAccess: this.mail.disableFileAccess,
            normalizeHeaderKey: this.mail.normalizeHeaderKey,
            newline: this.mail.newline
        });
    }

    /**
     * 获取子节点配置选项
     * @returns {Object} 子节点配置选项
     */
    _getChildNodeOptions() {
        return {
            disableUrlAccess: this.mail.disableUrlAccess,
            disableFileAccess: this.mail.disableFileAccess,
            normalizeHeaderKey: this.mail.normalizeHeaderKey,
            newline: this.mail.newline
        };
    }
}

module.exports = MailComposer;