'use strict';

const { Transform } = require('stream');

/**
 * 确保只使用 <CR><LF> 序列作为换行符（Windows风格换行）
 *
 * @param {Object} options 流选项
 */
class LeWindows extends Transform {
    constructor(options = {}) {
        super(options);
        this.options = options, this.lastByte = false;  // 记录上一个字节，用于跨 chunk 的换行符检测
    }

    /**
     * 转换函数：确保所有换行符都是 \r\n 格式
     */
    _transform(chunk, encoding, done) {
        if (chunk.length === 0) return done();
        if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding);  // 如果chunk是字符串,根据encoding转换为Buffer

        // 快速路径：无换行符直接推送
        if (!chunk.includes(0x0a)) {
            this.push(chunk), this.lastByte = chunk.at(-1);
            return done();
        }

        const crlf = Buffer.from('\r\n'), output = [];
        let start = 0;

        for (let i = 0; i < chunk.length; i++) {
            if (chunk[i] !== 0x0a) continue;    // 跳过非换行符

            const prevByte = i === 0 ? this.lastByte : chunk[i - 1];
            if (prevByte === 0x0d) continue;   // 已有 \r 前缀则跳过
            if (i > start) output.push(chunk.slice(start, i)); // 发现需要转换的换行符
            output.push(crlf), start = i + 1;  // 跳过当前 \n
        }

        if (start < chunk.length) output.push(chunk.slice(start));  // 添加剩余数据
        // 输出结果
        const result = output.length ? Buffer.concat(output) : chunk;
        this.push(result), this.lastByte = chunk.at(-1), done();
    }
}

module.exports = LeWindows;