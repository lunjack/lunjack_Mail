'use strict';

const { Transform } = require('stream');
const { regexs, resetRegex, } = require('./regexs');

/**
 * 将Buffer编码为Quoted-Printable格式的字符串
 *
 * @param {Buffer} buffer 要转换的Buffer
 * @returns {String} Quoted-Printable编码的字符串
 */
function qpEncode(buffer) {
    // 如果输入是字符串，先转换为Buffer
    if (typeof buffer === 'string') buffer = Buffer.from(buffer, 'utf-8');

    // 不需要编码的可用字符范围
    let ranges = [
        // https://tools.ietf.org/html/rfc2045#section-6.7
        // <TAB>,<LF>,<CR>
        [0x09], [0x0a], [0x0d],
        [0x20, 0x3c], // <SP>!"#$%&'()*+,-./0123456789:;
        [0x3e, 0x7e] // >?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}
    ];
    let result = '', ord;

    // 遍历buffer中的每个字节
    for (let i = 0, len = buffer.length; i < len; i++) {
        ord = buffer[i];
        // 如果字符在允许范围内，并且不是行尾的空格或制表符，则直接使用原字符
        if (checkRanges(ord, ranges) && !((ord === 0x20 || ord === 0x09) && (i === len - 1 || buffer[i + 1] === 0x0a
            || buffer[i + 1] === 0x0d))) {
            result += String.fromCharCode(ord);
            continue;
        }
        // 否则进行编码：=后跟两位十六进制数
        result += '=' + (ord < 0x10 ? '0' : '') + ord.toString(16).toUpperCase();
    }

    return result;
}

/**
 * 为Quoted-Printable字符串添加软换行
 *
 * @param {String} str 可能需要换行的Quoted-Printable编码字符串
 * @param {Number} [lineLength=76] 每行的最大允许长度
 * @returns {String} 经过软换行处理的Quoted-Printable编码字符串
 */
function qpWrap(str, lineLength) {
    str = (str || '').toString();
    lineLength = lineLength || 76;

    // 如果字符串长度不超过行限制，直接返回
    if (str.length <= lineLength) return str;

    let pos = 0;
    let len = str.length;
    let match, code, line;
    let lineMargin = Math.floor(lineLength / 3);
    let result = '';

    // 在需要的位置插入软换行
    while (pos < len) {
        line = str.slice(pos, pos + lineLength);
        // 处理已有的CRLF换行
        if ((match = line.match(regexs.CRLF))) {
            line = line.slice(0, match.index + match[0].length);
            result += line;
            pos += line.length;
            continue;
        }

        // 如果以换行符结尾，保持不变
        if (line.slice(-1) === '\n') {
            result += line;
            pos += line.length;
            continue;
        }
        else if ((match = line.slice(-lineMargin).match(regexs.TRAILING_NEWLINE))) {
            // 截断到最近的换行符
            line = line.slice(0, line.length - (match[0].length - 1));
            result += line;
            pos += line.length;
            continue;
        }
        else if (line.length > lineLength - lineMargin && (match = line.slice(-lineMargin).match(regexs.TRAILING_SPACE_OR_PUNCTUATION)))
            line = line.slice(0, line.length - (match[0].length - 1));  // 截断到最近的空格
        else if (line.match(regexs.INCOMPLETE_ENCODING)) {
            // 将不完整的编码序列推到下一行
            if ((match = line.match(regexs.INCOMPLETE_ENCODING_SHORT))) line = line.slice(0, line.length - match[0].length);

            resetRegex(regexs.COMPLETE_ENCODING);
            // 确保UTF-8序列不被分割
            while (line.length > 3 && line.length < len - pos && !line.match(regexs.UTF8_ENCODING)
                && (match = line.match(regexs.COMPLETE_ENCODING))) {
                code = parseInt(match[0].slice(1, 3), 16);
                if (code < 128) break;

                line = line.slice(0, line.length - 3);
                if (code >= 0xc0) break;
            }
        }

        // 添加软换行
        if (pos + line.length < len && line.slice(-1) !== '\n') {
            resetRegex(regexs.COMPLETE_ENCODING);
            if (line.length === lineLength && line.match(regexs.COMPLETE_ENCODING)) line = line.slice(0, line.length - 3);
            else if (line.length === lineLength) line = line.slice(0, line.length - 1);

            pos += line.length;
            line += '=\r\n';
        }
        else pos += line.length;

        result += line;
    }

    return result;
}

/**
 * 辅助函数：检查数字是否在指定范围内
 *
 * @param {Number} nr 要检查的数字
 * @param {Array} ranges 允许的值范围数组
 * @returns {Boolean} 如果在允许范围内返回true，否则返回false
 */
function checkRanges(nr, ranges) {
    for (let i = ranges.length - 1; i >= 0; i--) {
        // 如果范围为空，则跳过
        if (!ranges[i].length) continue;
        // 如果范围只有一个值，则直接比较
        if (ranges[i].length === 1 && nr === ranges[i][0]) return true;
        // 如果范围有两个值，则比较是否在范围内
        if (ranges[i].length === 2 && nr >= ranges[i][0] && nr <= ranges[i][1]) return true;
    }
    return false;
}

/*
 * 创建用于将数据编码为Quoted-Printable格式的转换流
 *
 * @constructor
 * @param {Object} options 流选项
 * @param {Number} [options.lineLength=76] 行最大长度，设置为false可禁用换行
 */
class QpEncoder extends Transform {
    constructor(options = {}) {
        super();
        this.options = options; // 初始化

        // 设置行长度，默认为76
        if (this.options.lineLength !== false) this.options.lineLength = this.options.lineLength || 76;

        this._curLine = ''; // 当前行缓存

        // 统计输入输出字节数
        this.inputBytes = 0;
        this.outputBytes = 0;
    }

    /**
     * 转换数据块
     */
    _transform(chunk, encoding, done) {
        let qp;

        // 确保chunk是Buffer类型
        if (encoding !== 'buffer') chunk = Buffer.from(chunk, encoding);
        // 空数据块直接返回
        if (!chunk || !chunk.length) return done();
        this.inputBytes += chunk.length;

        // 如果启用了行长度限制
        if (this.options.lineLength) {
            // 编码并添加换行
            qp = this._curLine + qpEncode(chunk);
            qp = qpWrap(qp, this.options.lineLength);
            qp = qp.replace(regexs.LAST_LINE, (match, lineBreak, lastLine) => {
                this._curLine = lastLine;
                return lineBreak;
            });

            if (qp) {
                this.outputBytes += qp.length;
                this.push(qp);
            }
        }
        // 不启用行长度限制，直接编码并输出
        else {
            qp = qpEncode(chunk);
            this.outputBytes += qp.length;
            this.push(qp, 'ascii');
        }

        done();
    }

    /**
     * 刷新流，输出剩余数据
     */
    _flush(done) {
        if (this._curLine) {
            this.outputBytes += this._curLine.length;
            this.push(this._curLine, 'ascii');
        }
        done();
    }
}

// 导出模块
module.exports = {
    qpEncode,
    QpEncoder
};