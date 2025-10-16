'use strict';

const MimeNode = require('./mime-node');
const { regexs, resetRegex } = require('./regexs');
const { parseDataURI } = require('./shared');
const { detectMimeType, detectExtension } = require('./mime-funcs');

/**
 * 邮件编译器类，用于从邮件选项组合MimeNode实例
 * 负责处理邮件的多部分结构（纯文本、HTML、附件等）
 * @class MailComposer
 */
class MailComposer {
    constructor(mail = {}) {
        this.mail = mail;
        this.message = false;
    }

    /**
     * 编译邮件内容，生成MimeNode实例
     * 根据邮件内容类型（纯文本、HTML、附件等）构建相应的MIME结构
     * @returns {MimeNode} 编译后的MimeNode实例
     */
    compile() {
        this._alternatives = this.getAlternatives();  // 获取所有替代内容（纯文本、HTML、日历事件等）
        // 从替代内容中提取HTML节点
        this._htmlNode = this._alternatives.filter(alternative => regexs.HTML_TYPE.test(alternative.contentType)).pop();
        // 获取附件，并根据是否存在HTML内容区分相关附件
        this._attachments = this.getAttachments(!!this._htmlNode);

        // 确定需要使用的MIME类型结构
        const aLen = this._attachments.attached.length;
        this._useRelated = !!(this._htmlNode && this._attachments.related.length); // 是否需要相关部分（HTML + 内联图片）
        this._useAlternative = this._alternatives.length > 1;                      // 是否需要替代部分（纯文本 + HTML）
        // 是否需要混合部分（内容 + 附件）
        this._useMixed = aLen > 1 || (this._alternatives.length && aLen === 1);

        // 根据内容类型构建相应的MIME结构
        if (this.mail.raw)  // 如果有raw字段，则直接使用raw字段
            this.message = new MimeNode('message/rfc822', { newline: this.mail.newline }).setRaw(this.mail.raw);
        else if (this._useMixed) this.message = this._createMixed();             // 混合类型：内容 + 多个附件
        else if (this._useAlternative) this.message = this._createAlternative(); // 替代类型：纯文本 + HTML
        else if (this._useRelated) this.message = this._createRelated();         // 相关类型：HTML + 内联资源
        else
            // 简单类型：单一内容
            this.message = this._createContentNode(
                false,
                [this._alternatives, this._attachments.attached]
                    .flatMap(arr => arr || [])
                    .find(Boolean) || { contentType: 'text/plain', content: '' }
            );

        if (this.mail.headers) this.message.addHeader(this.mail.headers);  // 添加自定义邮件头

        // 设置标准邮件头
        resetRegex(regexs.HYPHEN_REPLACE);
        ['from', 'sender', 'to', 'cc', 'bcc', 'reply-to', 'in-reply-to', 'references', 'subject', 'message-id', 'date']
            .forEach(header => {
                let key = header.replace(regexs.HYPHEN_REPLACE, (_, c) => c.toUpperCase());
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
    getAttachments(findRelated = false) {
        const { attachments = [] } = this.mail;
        let icalEvent, eventObject;

        // 处理日历事件附件
        const mIcalEvent = this.mail.icalEvent;
        if (mIcalEvent) {
            icalEvent = typeof mIcalEvent === 'object' && (mIcalEvent.content || mIcalEvent.path || mIcalEvent.href || mIcalEvent.raw)
                ? { ...mIcalEvent } : { content: mIcalEvent };

            eventObject = {
                ...icalEvent,
                contentType: 'application/ics',
                filename: icalEvent.filename || 'invite.ics',
                headers: { ...icalEvent.headers, 'Content-Disposition': 'attachment', 'Content-Transfer-Encoding': 'base64' }
            };
        }

        // 处理所有附件
        const processedAttachments = attachments.map((attachment, i) => {
            const pAttachment = this._prepareAttachmentObject(attachment); // 预处理附件
            const { filename, path, href, cid, raw, encoding, headers, contentType: cType, content, httpHeaders } = pAttachment;
            const source = path || href || 'bin';
            const contentType = cType || detectMimeType(filename || source);
            const isImage = regexs.IMAGE_TYPE.test(contentType);
            const isMessageNode = regexs.MESSAGE_TYPE.test(contentType);
            const contentDisposition = pAttachment.contentDisposition ||
                (isMessageNode || (isImage && cid) ? 'inline' : 'attachment');
            const contentTransferEncoding = 'contentTransferEncoding' in pAttachment
                ? pAttachment.contentTransferEncoding : isMessageNode ? '7bit' : 'base64';

            // 构建附件数据
            const data = {
                contentType, contentDisposition, contentTransferEncoding,
                ...(filename && { filename }),
                ...(cid && { cid }),
                ...(raw && { raw }),
                ...(encoding && { encoding }),
                ...(headers && { headers })
            };

            // 处理文件名生成
            if (!filename && !isMessageNode && filename !== false) {
                const baseName = source.split('/').pop().split('?').shift();
                data.filename = baseName && !baseName.includes('.')
                    ? `${baseName}.${detectExtension(contentType)}` : baseName || `attachment-${i + 1}`;
            }

            // 设置内容源（优先级：raw > path > href > content）
            if (!raw) data.content = path ? { path } : href ? { href, httpHeaders } : content || '';

            return data;
        });

        const eventArray = eventObject ? [eventObject] : [];
        return findRelated ? {
            attached: processedAttachments.filter(a => !a.cid).concat(eventArray),
            related: processedAttachments.filter(a => a.cid)
        } : { attached: processedAttachments.concat(eventArray), related: [] };
    }

    /**
     * 获取邮件的替代内容（纯文本、HTML、日历事件等）
     * 用于构建多部分替代结构
     * @returns {Array} 替代内容数组
     */
    getAlternatives() {
        let text, html, watchHtml, amp, icalEvent, eventObject;

        // 处理替代内容对象
        const processAlt = (letValue, value, defaultContentType) => {
            letValue =
                (typeof value === 'object' && (value.content || value.path || value.href || value.raw)) ? value : { content: value };
            letValue.contentType = defaultContentType;
            return letValue;
        };

        // 处理纯文本内容
        if (this.mail.text) text = processAlt(text, this.mail.text, 'text/plain; charset=utf-8');

        // 处理Apple Watch HTML内容
        if (this.mail.watchHtml) watchHtml = processAlt(watchHtml, this.mail.watchHtml, 'text/watch-html; charset=utf-8');

        // 处理AMP HTML内容
        if (this.mail.amp) amp = processAlt(amp, this.mail.amp, 'text/x-amp-html; charset=utf-8');

        // 处理日历事件
        if (this.mail.icalEvent) {
            icalEvent = processAlt(icalEvent, this.mail.icalEvent, null);

            eventObject = {
                ...icalEvent,
                filename: false,
                contentType: `text/calendar; charset=utf-8; method=${(icalEvent.method || 'PUBLISH').toString().trim().toUpperCase()}`,
                headers: icalEvent.headers || {},
                ...(icalEvent.content && typeof icalEvent.content === 'object' && { content: { ...icalEvent.content, _resolve: true } })
            };
        }

        // 处理HTML内容
        if (this.mail.html) html = processAlt(html, this.mail.html, 'text/html; charset=utf-8');

        // 将所有替代内容合并到数组中
        const alternatives = Array.prototype.concat.call([], text, watchHtml, amp, html, eventObject, this.mail.alternatives).filter(Boolean)
            .map(originalAlternative => {
                const alternative = this._prepareAttachmentObject(originalAlternative); // 预处理附件
                const { contentType, filename, path, href, raw, content, contentTransferEncoding, encoding, headers } = alternative;
                const data = ({
                    contentType: contentType || detectMimeType(filename || path || href || 'txt'),
                    contentTransferEncoding,
                    ...(raw && { raw }),
                    ...(filename && { filename }),
                    ...(encoding && { encoding }),
                    ...(headers && { headers })
                });

                // 设置内容源（优先级：raw > path > href > content）
                if (!raw) data.content = path ? { path } : href ? { href } : content || '';
                return data;
            });

        return alternatives;
    }

    /**
     * 预处理附件对象（处理dataURL和标准化路径）
     * @param {Object} obj - 要处理的附件对象
     * @returns {Object} 处理后的对象
     */
    _prepareAttachmentObject(obj) {
        let prepared = { ...obj }; // 创建处理副本
        // 处理dataURL格式的内容
        if (regexs.DATA_URL.test(prepared.path || prepared.href)) prepared = { ...prepared, ...this._processDataUrl(prepared) };
        return this._normalizeAttachmentPaths(prepared); // 标准化
    }

    /**
     * 创建MIME节点（根节点或子节点）
     * @param {MimeNode|null} parentNode - 父节点，如果为null则创建根节点
     * @param {string} mimeType - MIME类型
     * @returns {MimeNode} 创建的节点
     */
    _createMimeNode(parentNode, mimeType) {
        return !parentNode ? this._createRootMimeNode(mimeType) : parentNode.createChild(mimeType, this._getChildNodeOptions());
    }

    /**
     * 创建混合类型的MIME节点（内容 + 附件）
     * @param {MimeNode} parentNode - 父节点
     * @returns {MimeNode} 创建的混合节点
     */
    _createMixed(parentNode) {
        const node = this._createMimeNode(parentNode, 'multipart/mixed');
        // 根据内容类型添加子节点
        if (this._useAlternative) this._createAlternative(node);
        else if (this._useRelated) this._createRelated(node);

        // 添加所有替代内容和附件
        [...(this._useAlternative ? [] : this._alternatives || []), ...(this._attachments.attached || [])]
            .filter(element => !this._useRelated || element !== this._htmlNode)
            .forEach(element => this._createContentNode(node, element));

        return node;
    }

    /**
     * 创建替代类型的MIME节点（纯文本 + HTML）
     * @param {MimeNode} parentNode - 父节点
     * @returns {MimeNode} 创建的替代节点
     */
    _createAlternative(parentNode) {
        const node = this._createMimeNode(parentNode, 'multipart/alternative');
        // 添加所有替代内容
        this._alternatives.forEach(alternative => {
            this._useRelated && this._htmlNode === alternative ? this._createRelated(node) : this._createContentNode(node, alternative);
        });

        return node;
    }

    /**
     * 创建相关类型的MIME节点（HTML + 内联资源）
     * @param {MimeNode} parentNode - 父节点
     * @returns {MimeNode} 创建的相关节点
     */
    _createRelated(parentNode) {
        const node = this._createMimeNode(parentNode, 'multipart/related; type="text/html"');
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
    _createContentNode(parentNode, element = {}) {
        element.content = element.content || '';

        let node;
        resetRegex(regexs.ENCODING_FORMAT);
        let mainEncoding = (element.encoding || 'utf8').toString().toLowerCase().replace(regexs.ENCODING_FORMAT, '');

        const { baseBoundary, textEncoding, boundaryPrefix, disableUrlAccess, disableFileAccess, normalizeHeaderKey,
            newline, encoding } = this.mail
        const { filename, headers, cid, contentTransferEncoding, contentType, contentDisposition, content, raw } = element;
        // 创建节点（根节点或子节点）
        if (!parentNode)
            node = new MimeNode(contentType, {
                filename, baseBoundary, textEncoding, boundaryPrefix, disableUrlAccess, disableFileAccess, normalizeHeaderKey, newline
            });
        else
            node = parentNode.createChild(contentType, {
                filename, textEncoding, disableUrlAccess, disableFileAccess, normalizeHeaderKey, newline
            });

        // 设置节点头信息
        if (headers) node.addHeader(headers);
        resetRegex(regexs.CID_CLEAN);
        if (cid) node.setHeader('Content-Id', '<' + cid.replace(regexs.CID_CLEAN, '') + '>');
        if (contentTransferEncoding) node.setHeader('Content-Transfer-Encoding', contentTransferEncoding);
        else if (encoding && regexs.TEXT_TYPE.test(contentType)) node.setHeader('Content-Transfer-Encoding', encoding);

        // 设置内容处置方式
        if (!regexs.TEXT_TYPE.test(contentType) || contentDisposition || filename) node.setHeader
            ('Content-Disposition', contentDisposition || (cid && regexs.IMAGE_TYPE.test(contentType) ? 'inline' : 'attachment'));

        // 处理内容编码
        let newContent = content;
        if (typeof newContent === 'string' && !['utf8', 'usascii', 'ascii'].includes(mainEncoding))
            newContent = Buffer.from(newContent, mainEncoding);

        raw ? node.setRaw(raw) : node.setContent(newContent);  // 设置节点内容
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
            return {
                ...element, path: false, href: false, content: Buffer.alloc(0),
                contentType: element.contentType || 'application/octet-stream'
            };

        let parsedDataUri;
        try {
            parsedDataUri = parseDataURI(dataUrl);
        } catch (err) {
            return element;
        }

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
        if (regexs.HTTP_URL.test(attachment.path)) {
            attachment.href = attachment.path;
            attachment.path = undefined;
        }
        return attachment;
    }

    /**
     * 创建根MIME节点
     * @param {string} contentType - 内容类型
     * @returns {MimeNode} 创建的根节点
     */
    _createRootMimeNode(contentType) {
        const { baseBoundary, textEncoding, boundaryPrefix, disableUrlAccess, disableFileAccess, normalizeHeaderKey, newline } = this.mail;
        return new MimeNode(contentType, {
            baseBoundary, textEncoding, boundaryPrefix, disableUrlAccess, disableFileAccess, normalizeHeaderKey, newline
        });
    }

    /**
     * 获取子节点配置选项
     * @returns {Object} 子节点配置选项
     */
    _getChildNodeOptions() {
        const { disableUrlAccess, disableFileAccess, normalizeHeaderKey, newline } = this.mail;
        return { disableUrlAccess, disableFileAccess, normalizeHeaderKey, newline };
    }
}

module.exports = MailComposer;