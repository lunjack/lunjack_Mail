'use strict';

const { Transform } = require('stream');

/**
 * 将Buffer编码为base64字符串
 *
 * @param {Buffer} buffer 要转换的Buffer
 * @returns {String} base64编码的字符串
 */
function base64Encode(buffer) {
    if (typeof buffer === 'string') buffer = Buffer.from(buffer, 'utf-8');
    return buffer.toString('base64');
}

/**
 * 为base64字符串添加软换行
 *
 * @param {String} str 可能需要换行的base64编码字符串
 * @param {Number} [lineLength=76] 每行的最大允许长度
 * @returns {String} 软换行的base64编码字符串
 */
function base64Wrap(str = '', lineLength = 76) {
    str = str.toString();
    if (str.length <= lineLength) return str;

    let pos = 0;
    const result = [], chunkLength = lineLength * 1024;

    // 每行最多允许lineLength个字符，每1024行进行一次处理
    while (pos < str.length) {
        const end = pos + chunkLength, wLines = str.substring(pos, end).replace(new RegExp(`.{${lineLength}}`, 'g'), '$&\r\n');
        result.push(wLines), pos = end;
    }

    return result.join('');
}

/**
 * 创建用于将数据编码为base64的转换流
 *
 * @constructor
 * @param {Object} options 流选项
 * @param {Number} [options.lineLength=76] 行最大长度，设置为false可禁用换行
 */
class Base64Encoder extends Transform {
    constructor(options = {}) {
        super();
        this.options = options;

        // 默认每行76个字符
        const { lineLength } = this.options;
        if (lineLength !== false) this.options.lineLength = lineLength || 76;
        // 当前行内容,上次剩余的字节,输入字节数,输出字节数
        this._curLine = '', this._remainingBytes = false, this.inputBytes = 0, this.outputBytes = 0;
    }

    _transform(chunk, encoding, done) {
        if (encoding !== 'buffer') chunk = Buffer.from(chunk, encoding); // 如果不是Buffer，则按指定编码转换为Buffer
        if (!chunk?.length) return setImmediate(done);                   // 如果没有数据，直接返回

        this.inputBytes += chunk.length;
        // 如果上次有剩余的字节，先补齐
        const rLen = this._remainingBytes?.length ?? 0;
        if (rLen)
            chunk = Buffer.concat([this._remainingBytes, chunk], rLen + chunk.length), this._remainingBytes = false;

        // base64每3个字节编码为4个字符，如果不是3的倍数，则剩余的字节留到下次处理
        const remain = chunk.length % 3;
        if (remain) {
            const chunkEnd = chunk.length - remain;
            this._remainingBytes = chunk.slice(chunkEnd), chunk = chunk.slice(0, chunkEnd);
        }
        else this._remainingBytes = false;

        let b64 = this._curLine + base64Encode(chunk);
        const lineLength = this.options.lineLength;
        if (lineLength) {
            b64 = base64Wrap(b64, lineLength);
            const indexLF = b64.lastIndexOf('\n');              // 最后一个换行符位置
            if (indexLF < 0) this._curLine = b64, b64 = '';
            else {
                const nextIndex = indexLF + 1;
                this._curLine = b64.substring(nextIndex), b64 = b64.substring(0, nextIndex);
                if (b64 && !b64.endsWith('\r\n')) b64 += '\r\n'; // 确保以换行符结尾
            }
        }
        else this._curLine = ''; // 不换行

        if (b64) this.outputBytes += b64.length, this.push(Buffer.from(b64, 'ascii')); // 输出编码后的数据
        setImmediate(done);
    }

    // 处理剩余的字节(​Nodejs流机制在适当时候自动调用_flush)
    _flush(done) {
        const _rBytes = this._remainingBytes;
        if (_rBytes?.length) this._curLine += base64Encode(_rBytes);
        const _curLine = this._curLine;
        // 输出剩余的数据
        if (_curLine) this.outputBytes += _curLine.length, this.push(Buffer.from(_curLine, 'ascii')), this._curLine = '';
        done();
    }
}

// 导出接口
module.exports = { base64Encode, Base64Encoder };