'use strict';

const { Transform } = require('stream');

/**
 * 确保只使用 <CR><LF> 序列作为换行符（Windows风格换行）
 *
 * @param {Object} options 流选项
 */
class LeWindows extends Transform {
    constructor(options) {
        super(options);
        // 初始化 Transform 流
        this.options = options || {};
        this.lastByte = false;  // 记录上一个字节，用于跨 chunk 的换行符检测
    }

    /**
     * 转换函数：确保所有换行符都是 \r\n 格式
     */
    _transform(chunk, encoding, done) {
        let buf;
        let lastPos = 0;  // 记录上一个处理位置

        // 遍历当前 chunk 中的每个字节
        for (let i = 0, len = chunk.length; i < len; i++) {
            // 遇到 \n 字符
            if (chunk[i] === 0x0a) {
                // 检查前一个字符不是 \r（包括跨 chunk 的情况）
                if ((i && chunk[i - 1] !== 0x0d) || (!i && this.lastByte !== 0x0d)) {
                    // 将当前位置之前的数据输出
                    if (i > lastPos) {
                        buf = chunk.slice(lastPos, i);
                        this.push(buf);
                    }
                    // 插入 \r\n 替换单独的 \n
                    this.push(Buffer.from('\r\n'));
                    lastPos = i + 1;  // 更新处理位置
                }
            }
        }

        // 处理剩余数据
        if (lastPos && lastPos < chunk.length) {
            buf = chunk.slice(lastPos);
            this.push(buf);
        }
        // 如果没有需要转换的换行符，直接输出整个 chunk
        else if (!lastPos) this.push(chunk);

        // 记录最后一个字节，用于下一个 chunk 的换行符检测
        this.lastByte = chunk[chunk.length - 1];
        done();
    }
}

module.exports = LeWindows;