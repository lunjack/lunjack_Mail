'use strict';

const { Transform } = require('stream');

/**
 * 一个转换流，用于确保数据以正确的换行符结束
 * 继承自 stream.Transform
 */
class LastNewline extends Transform {
    constructor() {
        super();
        this.lastByte = false; // 保存最后一个字节用于判断换行状态
    }

    /**
     * 转换数据处理方法
     * @param {Buffer} chunk - 输入的数据块
     * @param {string} encoding - 编码方式
     * @param {function} done - 完成回调
     */
    _transform(chunk, encoding, done) {
        if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding);   // 如果是字符串，转换为Buffer
        if (chunk.length) this.lastByte = chunk.at(-1);                        // 如果数据块不为空，记录最后一个字节
        this.push(chunk), done(); // 将数据块推送到下一个流;完成
    }

    /**
     * 流结束时的处理逻辑
     * @param {function} done - 完成回调
     */
    _flush(done) {
        if (this.lastByte === 0x0a) return done();  // 如果最后一个字节是换行符，直接结束

        // 如果最后一个字节是回车符，添加换行符
        if (this.lastByte === 0x0d) {
            this.push(Buffer.from('\n'));
            return done();
        }

        this.push(Buffer.from('\r\n')); // 其他情况添加Windows风格的换行符\r\n
        return done();
    }
}

module.exports = LastNewline