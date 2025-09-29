/* eslint no-undefined: 0 */

'use strict';

const MimeNode = require('../mime-node');
const mimeFuncs = require('../mime-funcs');
const parseDataURI = require('../shared').parseDataURI;

/**
 * 创建用于从邮件选项组合MimeNode实例的对象
 */
class MailComposer {
    constructor(mail) {
        this.mail = mail || {};
        this.message = false;
    }

    compile() {
        this._alternatives = this.getAlternatives();
        this._htmlNode = this._alternatives.filter(alternative => /^text\/html\b/i.test(alternative.contentType)).pop();
        this._attachments = this.getAttachments(!!this._htmlNode);

        this._useRelated = !!(this._htmlNode && this._attachments.related.length);
        this._useAlternative = this._alternatives.length > 1;
        this._useMixed = this._attachments.attached.length > 1
            || (this._alternatives.length && this._attachments.attached.length === 1);

        if (this.mail.raw)
            this.message = new MimeNode('message/rfc822', { newline: this.mail.newline }).setRaw(this.mail.raw);
        else if (this._useMixed) this.message = this._createMixed();
        else if (this._useAlternative) this.message = this._createAlternative();
        else if (this._useRelated) this.message = this._createRelated();
        else
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

        if (this.mail.headers) this.message.addHeader(this.mail.headers);

        ['from', 'sender', 'to', 'cc', 'bcc', 'reply-to', 'in-reply-to', 'references', 'subject', 'message-id', 'date']
            .forEach(header => {
                let key = header.replace(/-(\w)/g, (o, c) => c.toUpperCase());
                if (this.mail[key]) this.message.setHeader(header, this.mail[key]);
            });

        if (this.mail.envelope) this.message.setEnvelope(this.mail.envelope);
        this.message.messageId();

        return this.message;
    }

    getAttachments(findRelated) {
        let icalEvent, eventObject;
        let attachments = [].concat(this.mail.attachments || []).map((attachment, i) => {
            if (/^data:/i.test(attachment.path || attachment.href)) attachment = this._processDataUrl(attachment);

            let contentType = attachment.contentType || mimeFuncs.detectMimeType(attachment.filename || attachment.path
                || attachment.href || 'bin');
            let isImage = /^image\//i.test(contentType);
            let isMessageNode = /^message\//i.test(contentType);
            let contentDisposition = attachment.contentDisposition || (isMessageNode || (isImage && attachment.cid)
                ? 'inline' : 'attachment');

            let contentTransferEncoding;
            if ('contentTransferEncoding' in attachment) contentTransferEncoding = attachment.contentTransferEncoding;
            else if (isMessageNode) contentTransferEncoding = '7bit';
            else contentTransferEncoding = 'base64';

            let data = { contentType, contentDisposition, contentTransferEncoding };

            if (attachment.filename) data.filename = attachment.filename;
            else if (!isMessageNode && attachment.filename !== false) {
                data.filename = (attachment.path || attachment.href || '').split('/').pop().split('?').shift()
                    || 'attachment-' + (i + 1);
                if (data.filename.indexOf('.') < 0) data.filename += '.' + mimeFuncs.detectExtension(data.contentType);
            }

            this._normalizeAttachmentPaths(attachment);

            if (attachment.cid) data.cid = attachment.cid;
            if (attachment.raw) data.raw = attachment.raw;
            else if (attachment.path) data.content = { path: attachment.path };
            else if (attachment.href) data.content = { href: attachment.href, httpHeaders: attachment.httpHeaders };
            else data.content = attachment.content || '';

            if (attachment.encoding) data.encoding = attachment.encoding;
            if (attachment.headers) data.headers = attachment.headers;

            return data;
        });

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

        if (!findRelated)
            return {
                attached: attachments.concat(eventObject || []),
                related: []
            };
        else
            return {
                attached: attachments.filter(attachment => !attachment.cid).concat(eventObject || []),
                related: attachments.filter(attachment => !!attachment.cid)
            };
    }

    getAlternatives() {
        let alternatives = [], text, html, watchHtml, amp, icalEvent, eventObject;

        if (this.mail.text) {
            if (typeof this.mail.text === 'object' && (this.mail.text.content || this.mail.text.path || this.mail.text.href
                || this.mail.text.raw)) text = this.mail.text;
            else text = { content: this.mail.text };
            text.contentType = 'text/plain; charset=utf-8';
        }

        if (this.mail.watchHtml) {
            if (typeof this.mail.watchHtml === 'object' && (this.mail.watchHtml.content || this.mail.watchHtml.path
                || this.mail.watchHtml.href || this.mail.watchHtml.raw)) watchHtml = this.mail.watchHtml;
            else watchHtml = { content: this.mail.watchHtml };
            watchHtml.contentType = 'text/watch-html; charset=utf-8';
        }

        if (this.mail.amp) {
            if (typeof this.mail.amp === 'object' && (this.mail.amp.content || this.mail.amp.path || this.mail.amp.href
                || this.mail.amp.raw)) amp = this.mail.amp;
            else amp = { content: this.mail.amp };
            amp.contentType = 'text/x-amp-html; charset=utf-8';
        }

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

        if (this.mail.html) {
            if (typeof this.mail.html === 'object' && (this.mail.html.content || this.mail.html.path || this.mail.html.href
                || this.mail.html.raw)) html = this.mail.html;
            else html = { content: this.mail.html };
            html.contentType = 'text/html; charset=utf-8';
        }

        [].concat(text || []).concat(watchHtml || []).concat(amp || []).concat(html || []).concat(eventObject
            || []).concat(this.mail.alternatives || [])
            .forEach(alternative => {
                if (/^data:/i.test(alternative.path || alternative.href)) alternative = this._processDataUrl(alternative);

                let data = {
                    contentType: alternative.contentType || mimeFuncs.detectMimeType(alternative.filename || alternative.path
                        || alternative.href || 'txt'),
                    contentTransferEncoding: alternative.contentTransferEncoding
                };

                if (alternative.filename) data.filename = alternative.filename;
                this._normalizeAttachmentPaths(alternative);

                if (alternative.raw) data.raw = alternative.raw;
                else if (alternative.path) data.content = { path: alternative.path };
                else if (alternative.href) data.content = { href: alternative.href };
                else data.content = alternative.content || '';

                if (alternative.encoding) data.encoding = alternative.encoding;
                if (alternative.headers) data.headers = alternative.headers;

                alternatives.push(data);
            });

        return alternatives;
    }

    _createMixed(parentNode) {
        let node;
        if (!parentNode) node = this._createRootMimeNode('multipart/mixed');
        else node = parentNode.createChild('multipart/mixed', this._getChildNodeOptions());

        if (this._useAlternative) this._createAlternative(node);
        else if (this._useRelated) this._createRelated(node);

        [].concat((!this._useAlternative && this._alternatives) || []).concat(this._attachments.attached || [])
            .forEach(element => {
                if (!this._useRelated || element !== this._htmlNode) this._createContentNode(node, element);
            });

        return node;
    }

    _createAlternative(parentNode) {
        let node;
        if (!parentNode) node = this._createRootMimeNode('multipart/alternative');
        else node = parentNode.createChild('multipart/alternative', this._getChildNodeOptions());

        this._alternatives.forEach(alternative => {
            if (this._useRelated && this._htmlNode === alternative) this._createRelated(node);
            else this._createContentNode(node, alternative);
        });

        return node;
    }

    _createRelated(parentNode) {
        let node;
        if (!parentNode) node = this._createRootMimeNode('multipart/related; type="text/html"');
        else node = parentNode.createChild('multipart/related; type="text/html"', this._getChildNodeOptions());

        this._createContentNode(node, this._htmlNode);
        this._attachments.related.forEach(alternative => this._createContentNode(node, alternative));
        return node;
    }

    _createContentNode(parentNode, element) {
        element = element || {};
        element.content = element.content || '';

        let node;
        let encoding = (element.encoding || 'utf8').toString().toLowerCase().replace(/[-_\s]/g, '');

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

        if (element.headers) node.addHeader(element.headers);
        if (element.cid) node.setHeader('Content-Id', '<' + element.cid.replace(/[<>]/g, '') + '>');
        if (element.contentTransferEncoding) node.setHeader('Content-Transfer-Encoding', element.contentTransferEncoding);
        else if (this.mail.encoding && /^text\//i.test(element.contentType))
            node.setHeader('Content-Transfer-Encoding', this.mail.encoding);

        if (!/^text\//i.test(element.contentType) || element.contentDisposition)
            node.setHeader('Content-Disposition', element.contentDisposition
                || (element.cid && /^image\//i.test(element.contentType) ? 'inline' : 'attachment'));

        if (typeof element.content === 'string' && !['utf8', 'usascii', 'ascii'].includes(encoding))
            element.content = Buffer.from(element.content, encoding);

        if (element.raw) node.setRaw(element.raw);
        else node.setContent(element.content);

        return node;
    }

    _processDataUrl(element) {
        const dataUrl = element.path || element.href;
        if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return element;

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

        element.content = parsedDataUri.data;
        element.contentType = element.contentType || parsedDataUri.contentType;
        if ('path' in element) element.path = false;
        if ('href' in element) element.href = false;

        return element;
    }

    // 标准化附件路径
    _normalizeAttachmentPaths(attachment) {
        if (/^https?:\/\//i.test(attachment.path)) {
            attachment.href = attachment.path;
            attachment.path = undefined;
        }
    }

    // 创建根Mime节点
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

    // 获取子节点选项
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