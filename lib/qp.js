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
    if (typeof buffer === 'string') buffer = Buffer.from(buffer, 'utf-8'); // 如果输入是字符串，先转换为Buffer

    // 不需要编码的可用字符范围
    const ranges = [
        // https://tools.ietf.org/html/rfc2045#section-6.7
        [0x09], [0x0a], [0x0d],  // <TAB>,<LF>,<CR>
        [0x20, 0x3c],            // <SP>!"#$%&'()*+,-./0123456789:;
        [0x3e, 0x7e]             // >?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}
    ];
    let result = '';

    // 遍历buffer中的每个字节
    for (let i = 0, len = buffer.length; i < len; i++) {
        const ord = buffer[i], nextByte = buffer[i + 1];

        // 如果字符在允许范围内，并且不是行尾的空格或制表符，则直接使用原字符
        if (checkRanges(ord, ranges) && !((ord === 0x20 || ord === 0x09) && (i === len - 1 || nextByte === 0x0a
            || nextByte === 0x0d))) {
            result += String.fromCharCode(ord);
            continue;
        }
        result += `=${(ord < 0x10 ? '0' : '')}${ord.toString(16).toUpperCase()}`; // 否则进行编码：=后跟两位十六进制数
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
function qpWrap(str = '', lineLength = 76) {
    str = str.toString();
    if (str.length <= lineLength) return str;  // 如果字符串长度不超过行限制，直接返回
    let pos = 0, match, code, line, result = '';
    const len = str.length, lineMargin = Math.floor(lineLength / 3);
    // 将行添加到结果中并更新位置
    function addLineAndUpdatePos(currentLine) { result += currentLine, pos += currentLine.length };

    // 在需要的位置插入软换行
    while (pos < len) {
        line = str.slice(pos, pos + lineLength);
        // 处理已有的CRLF换行
        if ((match = line.includes('\r\n'))) {
            line = line.slice(0, match.index + match[0].length), addLineAndUpdatePos(line);
            continue;
        }

        // 如果以换行符结尾，保持不变
        if (line.endsWith('\n')) {
            addLineAndUpdatePos(line);
            continue;
        }
        else if ((match = line.slice(-lineMargin).match(regexs.TRAILING_NEWLINE))) {
            line = line.slice(0, line.length - (match[0].length - 1)), addLineAndUpdatePos(line); // 截断到最近的换行符
            continue;
        }
        else if (line.length > lineLength - lineMargin && (match = line.slice(-lineMargin).match(regexs.TRAILING_SPACE_OR_PUNCTUATION)))
            line = line.slice(0, line.length - (match[0].length - 1));  // 截断到最近的空格
        else if (line.match(regexs.INCOMPLETE_ENCODING)) {
            // 将不完整的编码序列推到下一行
            if ((match = line.match(regexs.INCOMPLETE_ENCODING_SHORT))) line = line.slice(0, line.length - match[0].length);

            const rCE = resetRegex(regexs.COMPLETE_ENCODING);
            // 确保UTF-8序列不被分割
            while (line.length > 3 && line.length < len - pos && !line.match(regexs.UTF8_ENCODING) && (match = line.match(rCE))) {
                code = parseInt(match[0].slice(1, 3), 16);
                if (code < 128) break;

                line = line.slice(0, line.length - 3);
                if (code >= 0xc0) break;
            }
        }

        // 添加软换行
        if (pos + line.length < len && line.endsWith('\n')) {
            const rCE = resetRegex(regexs.COMPLETE_ENCODING);
            if (line.length === lineLength && line.match(rCE)) line = line.slice(0, line.length - 3);
            else if (line.length === lineLength) line = line.slice(0, line.length - 1);

            pos += line.length, line += '=\r\n';
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
        if (!ranges[i].length) continue;                                 // 如果范围为空，则跳过
        if (ranges[i].length === 1 && nr === ranges[i][0]) return true;  // 如果范围只有一个值，则直接比较
        if (ranges[i].length === 2 && nr >= ranges[i][0] && nr <= ranges[i][1]) return true;// 如果范围有两个值,则比较是否在范围内
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
        const { lineLength = 76 } = this.options;
        if (lineLength !== false) this.options.lineLength = lineLength; // 设置行长度，默认为76
        this._curLine = '', this.inputBytes = 0, this.outputBytes = 0;  // 当前行缓存和统计输入输出字节数
    }

    /**
     * 转换数据块
     */
    _transform(chunk, encoding, done) {
        let qp;
        if (encoding !== 'buffer') chunk = Buffer.from(chunk, encoding);  // 确保chunk是Buffer类型
        if (!chunk?.length) return done();                                // 空数据块直接返回
        this.inputBytes += chunk.length;

        // 如果启用了行长度限制
        const { lineLength } = this.options;
        if (lineLength) {
            // 编码并添加换行
            qp = qpWrap(this._curLine + qpEncode(chunk), lineLength);
            qp = qp.replace(regexs.LAST_LINE, (_, lineBreak, lastLine) => {
                this._curLine = lastLine;
                return lineBreak;
            });

            if (qp) this.outputBytes += qp.length, this.push(qp);
        }
        // 否则没有启用行长度限制，直接编码并输出
        else qp = qpEncode(chunk), this.outputBytes += qp.length, this.push(qp, 'ascii');
        done();
    }

    /**
     * 刷新流，输出剩余数据
     */
    _flush(done) {
        if (this._curLine) this.outputBytes += this._curLine.length, this.push(this._curLine, 'ascii');
        done();
    }
}

// 导出模块
module.exports = { qpEncode, QpEncoder };