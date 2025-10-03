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
function base64Wrap(str, lineLength) {
    str = (str || '').toString();
    lineLength = lineLength || 76;

    if (str.length <= lineLength) return str;

    let result = [];
    let pos = 0;
    let chunkLength = lineLength * 1024;

    // 每行最多允许lineLength个字符，每1024行进行一次处理
    while (pos < str.length) {
        let wrappedLines = str.substring(pos, pos + chunkLength).replace(new RegExp('.{' + lineLength + '}', 'g'), '$&\r\n');
        result.push(wrappedLines);
        pos += chunkLength;
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
        if (this.options.lineLength !== false) this.options.lineLength = this.options.lineLength || 76;

        this._curLine = ''; // 当前行内容
        this._remainingBytes = false; // 上次剩余的字节

        this.inputBytes = 0;
        this.outputBytes = 0;
    }

    _transform(chunk, encoding, done) {
        // 如果不是Buffer，则按指定编码转换为Buffer
        if (encoding !== 'buffer') chunk = Buffer.from(chunk, encoding);
        // 如果没有数据，直接返回
        if (!chunk || !chunk.length) return setImmediate(done);

        this.inputBytes += chunk.length;

        // 如果上次有剩余的字节，先补齐
        if (this._remainingBytes && this._remainingBytes.length) {
            chunk = Buffer.concat([this._remainingBytes, chunk], this._remainingBytes.length + chunk.length);
            this._remainingBytes = false;
        }

        // base64每3个字节编码为4个字符，如果不是3的倍数，则剩余的字节留到下次处理
        if (chunk.length % 3) {
            this._remainingBytes = chunk.slice(chunk.length - (chunk.length % 3));
            chunk = chunk.slice(0, chunk.length - (chunk.length % 3));
        }
        else this._remainingBytes = false;

        let b64 = this._curLine + base64Encode(chunk);

        if (this.options.lineLength) {
            b64 = base64Wrap(b64, this.options.lineLength);

            let lastLF = b64.lastIndexOf('\n'); // 最后一个换行符位置
            if (lastLF < 0) {
                this._curLine = b64;
                b64 = '';
            }
            else {
                this._curLine = b64.substring(lastLF + 1);
                b64 = b64.substring(0, lastLF + 1);

                if (b64 && !b64.endsWith('\r\n')) b64 += '\r\n'; // 确保以换行符结尾
            }
        }
        else this._curLine = ''; // 不换行

        // 输出编码后的数据
        if (b64) {
            this.outputBytes += b64.length;
            this.push(Buffer.from(b64, 'ascii'));
        }

        setImmediate(done);
    }

    _flush(done) {
        // 处理剩余的字节
        if (this._remainingBytes && this._remainingBytes.length) this._curLine += base64Encode(this._remainingBytes);

        // 输出剩余的数据
        if (this._curLine) {
            this.outputBytes += this._curLine.length;
            this.push(Buffer.from(this._curLine, 'ascii'));
            this._curLine = '';
        }
        done();
    }
}

// 导出接口
module.exports = {
    base64Encode, // 编码
    Base64Encoder // 转换流
};