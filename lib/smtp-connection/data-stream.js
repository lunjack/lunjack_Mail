'use strict';

const { Transform } = require('stream');

/**
 * 转义行首的点。以<CR><LF>.<CR><LF>结束流
 * 同时确保只使用<CR><LF>作为换行序列
 *
 * @param {Object} options 流选项
 */
class DataStream extends Transform {
    constructor(options = {}) {
        super(options);
        this.options = options, this._curLine = '', this.inByteCount = 0, this.outByteCount = 0, this.lastByte = false;
    }

    /**
     * 转义点号的处理函数
     */
    _transform(chunk, encoding, done) {
        if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding);   // 如果chunk是字符串，则将其转换为Buffer
        if (!chunk?.length) return done();                                     // 如果chunk为空则直接返回
        const chunks = [];
        let chunklen = 0, lastPos = 0, buf;

        this.inByteCount += chunk.length;
        // 遍历chunk中的每个字节
        for (let i = 0; i < chunk.length; i++) {
            if (chunk[i] === 0x2e) {
                // 遇到点号(.)，检查是否在行首,如果在,那么在行首的点号前额外添加一个点号进行转义
                if ((i && chunk[i - 1] === 0x0a) || (!i && (!this.lastByte || this.lastByte === 0x0a))) {
                    buf = chunk.slice(lastPos, i + 1), chunks.push(buf), chunks.push(Buffer.from('.'));
                    chunklen += buf.length + 1, lastPos = i + 1;
                }
            }
            else if (chunk[i] === 0x0a) {
                // 遇到换行符(\n)，检查前面是否有回车符(\r)
                if ((i && chunk[i - 1] !== 0x0d) || (!i && this.lastByte !== 0x0d)) {
                    i > lastPos ? (buf = chunk.slice(lastPos, i), chunks.push(buf), chunklen += buf.length + 2) : chunklen += 2;
                    chunks.push(Buffer.from('\r\n')), lastPos = i + 1;
                }
            }
        }

        // 如果有处理过的数据块
        if (chunklen) {
            // 添加最后一段数据
            if (lastPos < chunk.length) buf = chunk.slice(lastPos), chunks.push(buf), chunklen += buf.length;
            this.outByteCount += chunklen, this.push(Buffer.concat(chunks, chunklen));
        }
        else this.outByteCount += chunk.length, this.push(chunk); // 没有需要转义的情况，直接推送原数据

        this.lastByte = chunk.at(-1); done(); // 记录最后一个字节后,完成处理
    }

    /**
     * 结束流处理，添加终止序列
     */
    _flush(done) {
        let buf;
        // 根据最后一个字节的类型添加适当的终止序列
        if (this.lastByte === 0x0a) buf = Buffer.from('.\r\n');        // 如果最后是LF，直接添加点号和CRLF
        else if (this.lastByte === 0x0d) buf = Buffer.from('\n.\r\n'); // 如果最后是CR，添加LF、点号和CRLF
        else buf = Buffer.from('\r\n.\r\n');                           // 其他情况，添加完整的CRLF、点号和CRLF

        this.outByteCount += buf.length, this.push(buf), done();
    }
}

module.exports = DataStream;