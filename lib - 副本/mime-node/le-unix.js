'use strict';

const { Transform } = require('stream');

/**
 * 确保仅使用 <LF> 作为换行符（Windows风格换行符处理）
 *
 * @param {Object} options 流选项
 */
class LeWindows extends Transform {
    constructor(options = {}) {
        super(options);
        this.options = options;
    }

    /**
     * 转换函数 - 处理数据块中的换行符
     * @param {Buffer} chunk 数据块
     * @param {string} encoding 编码格式
     * @param {Function} done 完成回调
     */
    _transform(chunk, encoding, done) {
        if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding);  // 如果chunk是字符串,根据encoding转换为Buffer
        let buf, lastPos = 0;

        // 遍历数据块中的每个字节
        for (let i = 0; i < chunk.length; i++) {
            // 如果,遇到回车符, 则提取从上次位置到当前回车符之前的数据(跳过回车符,推送处理后的数据)
            if (chunk[i] === 0x0d) buf = chunk.subarray(lastPos, i), lastPos = i + 1, this.push(buf);
        }

        // 如果剩余数据为真，则推送最后一个回车符之后的数据
        if (lastPos && lastPos < chunk.length) buf = chunk.subarray(lastPos), this.push(buf);
        else if (!lastPos) this.push(chunk); // 否则, 如果没有找到回车符，直接推送整个数据块
        done();
    }
}

module.exports = LeWindows;