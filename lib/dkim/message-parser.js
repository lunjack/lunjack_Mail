'use strict';

const { Transform } = require('stream');
const { regexs } = require('../regexs');

/**
 * MessageParser实例是一个转换流，用于将消息头与消息体分离。
 * 头信息通过'headers'事件发射。消息体作为结果流传递。
 */
class MessageParser extends Transform {
    constructor(options) {
        super(options);
        this.lastBytes = Buffer.alloc(4), this.headersParsed = false, this.rawHeaders = false;
        this.bodySize = 0, this.headerBytes = 0, this.headerChunks = [];
    }

    // 处理下一个数据块
    _transform(chunk, encoding, callback) {
        if (!chunk?.length) return callback();                                 // 忽略空块
        if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding);   // 确保块是一个Buffer

        try {
            const headersFound = this.checkHeaders(chunk);                     // 检查并处理头信息
            if (headersFound) this.bodySize += chunk.length, this.push(chunk); // 如果找到了头信息,推送剩余的消息体
            setImmediate(callback);
        } catch (E) {
            return callback(E);
        }
    }

    // 在流结束时处理任何剩余的头信息
    _flush(callback) {
        // 如果还有未处理的头信息块，则推送它们
        if (this.headerChunks) {
            const chunk = Buffer.concat(this.headerChunks, this.headerBytes);
            this.bodySize += chunk.length, this.push(chunk), this.headerChunks = null;
        }
        callback(); // 完成
    }

    /**
     * 更新记录最后4个字节，以便在块边界检测换行符
     *
     * @param {Buffer} data 来自流的下一个数据块
     */
    updateLastBytes(data) {
        const lblen = this.lastBytes.length, nblen = Math.min(data.length, lblen);

        // 移动现有字节
        for (let i = 0, len = lblen - nblen; i < len; i++) this.lastBytes[i] = this.lastBytes[i + nblen];
        // 添加新字节
        for (let i = 1; i <= nblen; i++) this.lastBytes[lblen - i] = data[data.length - i];
    }

    /**
     * 从剩余的消息体中查找并移除消息头。将头信息保持分离，直到最终投递，以便修改
     *
     * @param {Buffer} data 下一个数据块
     * @return {Boolean} 如果已经找到头信息则返回true，否则返回false
     */
    checkHeaders(data) {
        if (this.headersParsed) return true; // 如果已经找到头信息，则不需要检查

        const lblen = this.lastBytes.length;
        let headerPos = 0;
        this.curLinePos = 0;
        // 检查是否有两个连续的换行符，表示头信息的结尾
        for (let i = 0; i < lblen + data.length; i++) {
            const chr = i < lblen ? this.lastBytes[i] : data[i - lblen]; // 如果小于长度,使用lastBytes中的字节,否则使用data中的字节
            // 检查是否有两个连续的换行符
            if (chr === 0x0a && i) {
                const pr1 = i - 1 < lblen ? this.lastBytes[i - 1] : data[i - 1 - lblen], // 定义pr1为当前字节的前一个字节的值
                    // 定义pr2为当前字节的前两个字节的值(如果存在)
                    pr2 = i > 1 ? (i - 2 < lblen ? this.lastBytes[i - 2] : data[i - 2 - lblen]) : false;

                // 如果前一个字符是0x0a，或者前两个字符是0x0d 0x0a，则表示头信息结束
                if (pr1 === 0x0a || (pr1 === 0x0d && pr2 === 0x0a)) {
                    this.headersParsed = true, headerPos = i - lblen + 1, this.headerBytes += headerPos;
                    break;
                }
            }
        }

        // 如果找到了头信息
        if (this.headersParsed) {
            this.headerChunks.push(data.subarray(0, headerPos)), this.rawHeaders = Buffer.concat(this.headerChunks, this.headerBytes);
            this.headerChunks = null, this.emit('headers', this.parseHeaders());
            // 如果数据块中还有剩余的消息体，则推送剩余的消息体
            if (data.length - 1 > headerPos) {
                const chunk = data.subarray(headerPos);
                this.bodySize += chunk.length, setImmediate(() => this.push(chunk));
            }
            return true;
        }
        // 否则将整个数据块添加到头信息块中
        else this.headerBytes += data.length, this.headerChunks.push(data);

        this.updateLastBytes(data);  // 更新最后的字节
        return false;
    }

    // 解析原始头信息为键值对数组
    parseHeaders() {
        const lines = (this.rawHeaders || '').toString().split(regexs.LINE_SEPARATOR); // 按行拆分(丢弃换行符)
        // 处理折叠的头信息行
        for (let i = lines.length - 1; i > 0; i--)
            // 如果当前行是空白行，则将其与前一行合并
            if (regexs.FOLDED_HEADER_LINE.test(lines[i])) lines[i - 1] += `\n${lines[i]}`, lines.splice(i, 1);

        return lines.filter(line => line.trim())
            .map(line => { key: line.slice(0, line.indexOf(':')).trim().toLowerCase(), line });
    }
}

module.exports = MessageParser;