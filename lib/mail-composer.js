'use strict';

const MimeNode = require('./mime-node');
const { regexs, resetRegex, parseDataURI } = require('./shared');
const { detectMimeType, detectExtension } = require('./mime-funcs');

/**
 * 邮件编译器类，用于从邮件选项组合MimeNode实例
 * 负责处理邮件的多部分结构（纯文本、HTML、附件等）
 * @class MailComposer
 */
class MailComposer {
    constructor(mail = {}) { this.mail = mail, this.message = false; }

    /**
     * 编译邮件内容，生成MimeNode实例
     * 根据邮件内容类型（纯文本、HTML、附件等）构建相应的MIME结构
     * @returns {MimeNode} 编译后的MimeNode实例
     */
    compile() {
        const aTives = this._alternatives = this.getAlternatives();  // 获取所有替代内容（纯文本、HTML、日历事件等）
        // 从替代内容中提取HTML节点
        this._htmlNode = aTives.filter(alternative => regexs.HTML_TYPE.test(alternative.contentType)).pop();
        // 获取附件，并根据是否存在HTML内容区分相关附件
        const { attached, related } = this._attachments = this.getAttachments(!!this._htmlNode);

        // 确定需要使用的MIME类型结构
        this._useRelated = !!(this._htmlNode && related.length);                          // 是否需要相关部分（HTML + 内联图片）
        this._useAlternative = aTives.length > 1;                                         // 是否需要替代部分（纯文本 + HTML）
        this._useMixed = attached.length > 1 || (aTives.length && attached.length === 1); // 是否需要混合部分（内容 + 附件）

        // 根据内容类型构建相应的MIME结构
        const { raw, newline, headers, envelope } = this.mail;
        if (raw) this.message = new MimeNode('message/rfc822', { newline }).setRaw(raw); // 如果有raw字段，则直接使用raw字段
        else if (this._useMixed) this.message = this._createMixed();                     // 混合类型：内容 + 多个附件
        else if (this._useAlternative) this.message = this._createAlternative();         // 替代类型：纯文本 + HTML
        else if (this._useRelated) this.message = this._createRelated();                 // 相关类型：HTML + 内联资源
        else this.message = this._createContentNode(false, [aTives, attached].flatMap(arr => arr || [])
            .find(Boolean) || { contentType: 'text/plain', content: '' });               // 简单类型：单一内容

        if (headers) this.message.addHeader(headers);  // 添加自定义邮件头
        // 设置标准邮件头
        const rHR = resetRegex(regexs.HYPHEN_REPLACE);
        ['from', 'sender', 'to', 'cc', 'bcc', 'reply-to', 'in-reply-to', 'references', 'subject', 'message-id', 'date']
            .forEach(header => {
                const key = header.replace(rHR, (_, c) => c.toUpperCase());
                if (this.mail[key]) this.message.setHeader(header, this.mail[key]);
            });

        // 设置邮件信封和消息ID
        if (envelope) this.message.setEnvelope(envelope);
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
        const { attachments = [], icalEvent } = this.mail;
        let eventObject;

        // 处理日历事件附件
        if (icalEvent) {
            const iEvent = typeof icalEvent === 'object' && (icalEvent.content || icalEvent.path || icalEvent.href || icalEvent.raw)
                ? { ...icalEvent } : { content: icalEvent };

            eventObject = {
                ...iEvent, contentType: 'application/ics', filename: iEvent.filename || 'invite.ics',
                headers: { ...iEvent.headers, 'Content-Disposition': 'attachment', 'Content-Transfer-Encoding': 'base64' }
            };
        }

        // 处理所有附件
        const pAttachments = attachments.map((attachment, i) => {
            const pAtt = this._prepareAttachmentObject(attachment), // 预处理附件
                { filename, path, href, cid, raw, encoding, headers, contentType: cType, content = '', httpHeaders } = pAtt,
                source = path || href || 'bin', contentType = cType || detectMimeType(filename || source),
                isImage = regexs.IMAGE_TYPE.test(contentType), isMessageNode = regexs.MESSAGE_TYPE.test(contentType),
                contentDisposition = pAtt.contentDisposition || (isMessageNode || (isImage && cid) ? 'inline' : 'attachment'),
                contentTransferEncoding = 'contentTransferEncoding' in pAtt ? pAtt.contentTransferEncoding
                    : isMessageNode ? '7bit' : 'base64',
                // 构建附件数据
                data = {
                    contentType, contentDisposition, contentTransferEncoding, ...(filename && { filename }),
                    ...(cid && { cid }), ...(raw && { raw }), ...(encoding && { encoding }), ...(headers && { headers })
                };

            // 处理文件名生成
            if (!filename && !isMessageNode && filename !== false) {
                const baseName = source.split('/').pop().split('?').shift();
                data.filename = baseName && !baseName.includes('.')
                    ? `${baseName}.${detectExtension(contentType)}` : baseName || `attachment-${i + 1}`;
            }

            // 设置内容源（优先级：raw > path > href > content）
            if (!raw) data.content = path ? { path } : href ? { href, httpHeaders } : content;
            return data;
        }), eventArray = eventObject ? [eventObject] : [];
        return findRelated ?
            { attached: pAttachments.filter(a => !a.cid).concat(eventArray), related: pAttachments.filter(a => a.cid) }
            : { attached: pAttachments.concat(eventArray), related: [] };
    }

    /**
     * 获取邮件的替代内容（纯文本、HTML、日历事件等）
     * 用于构建多部分替代结构
     * @returns {Array} 替代内容数组
     */
    getAlternatives() {
        let text_, html_, watchHtml_, amp_, eventObject;
        const { text, html, watchHtml, amp, icalEvent, alternatives } = this.mail,
            // 处理替代内容对象
            processAlt = (letValue, v, defaultContentType) => {
                letValue = (typeof v === 'object' && (v.content || v.path || v.href || v.raw)) ? v : { content: v };
                letValue.contentType = defaultContentType;
                return letValue;
            };

        // 处理纯文本内容,Apple Watch HTML内容,AMP HTML内容
        if (text) text_ = processAlt(text_, text, 'text/plain; charset=utf-8');
        if (watchHtml) watchHtml_ = processAlt(watchHtml_, watchHtml, 'text/watch-html; charset=utf-8');
        if (amp) amp_ = processAlt(amp_, amp, 'text/x-amp-html; charset=utf-8');

        // 处理日历事件
        if (icalEvent) {
            const iEvent = processAlt(iEvent, icalEvent, null);
            eventObject = {
                ...iEvent, filename: false,
                contentType: `text/calendar; charset=utf-8; method=${(iEvent.method || 'PUBLISH').toString().trim().toUpperCase()}`,
                headers: iEvent.headers || {},
                ...(iEvent.content && typeof iEvent.content === 'object' && { content: { ...iEvent.content, _resolve: true } })
            };
        }

        // 处理HTML内容
        if (html) html_ = processAlt(html_, html, 'text/html; charset=utf-8');

        // 将所有替代内容合并到数组中
        const gAlternatives = Array.prototype.concat.call([], text_, html_, watchHtml_, amp_, eventObject, alternatives)
            .filter(Boolean).map(originalAlternative => {
                const oAtive = this._prepareAttachmentObject(originalAlternative), // 预处理附件
                    { contentType, filename, path, href, raw, content = '', contentTransferEncoding, encoding, headers } = oAtive,
                    data = ({
                        contentType: contentType || detectMimeType(filename || path || href || 'txt'), contentTransferEncoding,
                        ...(raw && { raw }), ...(filename && { filename }), ...(encoding && { encoding }), ...(headers && { headers })
                    });

                if (!raw) data.content = path ? { path } : href ? { href } : content;// 设置内容源(优先级:raw>path>href>content)
                return data;
            });

        return gAlternatives;
    }

    /**
     * 预处理附件对象（处理dataURL和标准化路径,将HTTP / HTTPS路径转换为href属性）
     * @param {Object} obj - 要处理的附件对象
     * @returns {Object} 处理后的对象
     */
    _prepareAttachmentObject(obj) {
        // 处理dataURL格式的内容和标准化路径
        const prepared = regexs.DATA_URL.test(obj.path || obj.href) ? { ...obj, ...this._processDataUrl(obj) } : { ...obj },
            { path } = prepared;
        if (regexs.HTTP_URL.test(path)) prepared.href = path, prepared.path = undefined;
        return prepared;
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
        this._alternatives.forEach(ative => {
            this._useRelated && this._htmlNode === ative ? this._createRelated(node) : this._createContentNode(node, ative);
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
        const { encoding = 'utf8', filename, headers, cid, contentTransferEncoding, contentType, contentDisposition,
            content = '', raw } = element, rEF = resetRegex(regexs.ENCODING_FORMAT),
            eEncoding = encoding.toString().toLowerCase().replace(rEF, ''),
            { baseBoundary, textEncoding, boundaryPrefix, disableUrlAccess, disableFileAccess, normalizeHeaderKey, newline,
                encoding: mEncoding } = this.mail

        // 创建节点（根节点或子节点）
        const node = !parentNode ? new MimeNode(contentType, {
            filename, baseBoundary, textEncoding, boundaryPrefix, disableUrlAccess, disableFileAccess, normalizeHeaderKey, newline
        }) : parentNode.createChild(contentType, {
            filename, textEncoding, disableUrlAccess, disableFileAccess, normalizeHeaderKey, newline
        });

        // 设置节点头信息
        if (headers) node.addHeader(headers);
        const rCC = resetRegex(regexs.CID_CLEAN), CTE = 'Content-Transfer-Encoding';
        if (cid) node.setHeader('Content-Id', `<${cid.replace(rCC, '')}>`);
        if (contentTransferEncoding) node.setHeader(CTE, contentTransferEncoding);
        else if (mEncoding && regexs.TEXT_TYPE.test(contentType)) node.setHeader(CTE, mEncoding);

        // 设置内容处置方式
        if (!regexs.TEXT_TYPE.test(contentType) || contentDisposition || filename) node.setHeader('Content-Disposition',
            contentDisposition || (cid && regexs.IMAGE_TYPE.test(contentType) ? 'inline' : 'attachment'));

        // 处理内容编码
        let newContent = content;
        if (typeof newContent === 'string' && !['utf8', 'usascii', 'ascii'].includes(eEncoding))
            newContent = Buffer.from(newContent, eEncoding);

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
        const { path, href, contentType = 'application/octet-stream' } = element, dataUrl = path || href;
        if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return element;
        // 对过大的DataURL进行限制
        if (dataUrl.length > 100000) return { ...element, path: false, href: false, content: Buffer.alloc(0), contentType };

        let parsedDataUri;
        try {
            parsedDataUri = parseDataURI(dataUrl);
        } catch (err) {
            return element;
        }

        // 替换DataURL为解析后的内容
        element.content = parsedDataUri.data, element.contentType = parsedDataUri.contentType || contentType;
        if ('path' in element) element.path = false;
        if ('href' in element) element.href = false;

        return element;
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