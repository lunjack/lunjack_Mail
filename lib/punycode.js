/*
    Punycode.js
    主要功能包括：
    1.将Unicode字符串转换为Punycode字符串（仅包含ASCII字符）。
    2.将Punycode字符串转换回Unicode字符串。
    3.处理域名或电子邮件地址的转换，其中只有非ASCII部分会被转换。
    4.将Unicode字符串转换为Punycode字符串，并将结果附加到域名或电子邮件地址的非ASCII部分之前。
*/

'use strict';

const { regexs, resetRegex, } = require('./regexs');

/** 32位最大正数浮点值 */
const maxInt = 2147483647; // 即 0x7FFFFFFF 或 2^31-1

/** Bootstring 参数 */
const base = 36;        // 基础数值
const tMin = 1;         // 阈值最小值
const tMax = 26;        // 阈值最大值
const skew = 38;        // 偏差值
const damp = 700;       // 阻尼因子
const initialBias = 72; // 初始偏差
const initialN = 128;   // 初始N值 0x80
const delimiter = '-';  // 分隔符 '\x2D'

/** 错误消息 */
const errors = {
    overflow: '溢出：输入需要更宽的整数来处理',
    'not-basic': '非法输入 >= 0x80（不是基本码点）',
    'invalid-input': '无效输入'
};

/** 便捷缩写 */
const baseMinusTMin = base - tMin;           // 基础值减去阈值最小值
const floor = Math.floor;                    // 向下取整函数
const strFromCharCode = String.fromCharCode; // 字符代码转字符串函数

/*--------------------------------------------------------------------------*/

/**
 * 通用错误工具函数
 * @private
 * @param {String} type 错误类型
 * @returns {Error} 抛出带有相应错误消息的 `RangeError`
 */
function error(type) {
    throw new RangeError(errors[type]);
}

/**
 * 通用的 `Array#map` 工具函数
 * @private
 * @param {Array} array 要遍历的数组
 * @param {Function} callback 为每个数组项调用的函数
 * @returns {Array} 回调函数返回值的新数组
 */
function map(array, callback) {
    const result = [];
    let length = array.length;
    while (length--) {
        result[length] = callback(array[length]);
    }
    return result;
}

/**
 * 一个简单的类似 `Array#map` 的包装器，用于处理域名字符串或电子邮件地址
 * @private
 * @param {String} domain 域名或电子邮件地址
 * @param {Function} callback 为每个字符调用的函数
 * @returns {String} 回调函数返回的字符组成的新字符串
 */
function mapDomain(domain, callback) {
    const parts = domain.split('@');
    let result = '';
    if (parts.length > 1) {
        // 在电子邮件地址中，只有域名部分应进行punycode编码。保持本地部分（即`@`之前的所有内容）不变。
        result = parts[0] + '@';
        domain = parts[1];
    }
    // 为了IE8兼容性，避免使用`split(regex)`。参见 #17。
    resetRegex(regexs.SEPARATORS);
    domain = domain.replace(regexs.SEPARATORS, '\x2E');
    const encoded = map(domain.split('.'), callback).join('.');
    return result + encoded;
}

/**
 * 创建一个包含字符串中每个Unicode字符的数字码点的数组。
 * 虽然JavaScript内部使用UCS-2，但此函数会将一对代理半部（UCS-2将每个半部公开为单独的字符）
 * 转换为单个码点，以匹配UTF-16。
 * @see `punycode.ucs2.encode`
 * @memberOf punycode.ucs2
 * @name decode
 * @param {String} string Unicode输入字符串（UCS-2）
 * @returns {Array} 新的码点数组
 */
function ucs2decode(string) {
    const output = [];
    let counter = 0;
    const length = string.length;
    while (counter < length) {
        const value = string.charCodeAt(counter++); // 获取当前字符的UTF-16代码单元
        // 如果是高代理项（范围：0xD800-0xDBFF）并且不是最后一个字符
        if (value >= 0xd800 && value <= 0xdbff && counter < length) {
            const extra = string.charCodeAt(counter++); // 获取下一个字符
            // 如果下一个字符是低代理项,则添加代理项对。
            if ((extra & 0xfc00) == 0xdc00) output.push(((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000);
            // 否则，这不是有效的代理对，只输出高代理项
            else {
                output.push(value);
                counter--; // 回退计数器
            }
        }
        else output.push(value); // 否则,仅追加此代码单
    }
    return output;
}

/**
 * 基于数字码点数组创建字符串。
 * @see `punycode.ucs2.decode`
 * @memberOf punycode.ucs2
 * @name encode
 * @param {Array} codePoints 数字码点数组
 * @returns {String} 新的Unicode字符串（UCS-2）
 */
function ucs2encode(codePoints) {
    return String.fromCodePoint(...codePoints);
}

/**
 * 将基本码点转换为数字/整数。
 * @see `digitToBasic()`
 * @private
 * @param {Number} codePoint 基本数字码点值
 * @returns {Number} 基本码点的数值（用于表示整数），范围从`0`到`base - 1`，如果码点不表示值，则返回`base`
 */
function basicToDigit(codePoint) {
    // 如果码点在`0x30`（`0`）到`0x39`（`9`）范围内，则返回其数值。
    if (codePoint >= 0x30 && codePoint < 0x3a) return 26 + (codePoint - 0x30);
    // 如果码点在`0x41`（`A`）到`0x5a`（`Z`）范围内，则返回其数值。
    if (codePoint >= 0x41 && codePoint < 0x5b) return codePoint - 0x41;
    // 如果码点在`0x61`（`a`）到`0x7a`（`z`）范围内，则返回其数值。
    if (codePoint >= 0x61 && codePoint < 0x7b) return codePoint - 0x61;
    return base; // 不在基本字符范围内
}

/**
 * 将数字/整数转换为基本码点。
 * @see `basicToDigit()`
 * @private
 * @param {Number} digit 基本码点的数值
 * @returns {Number} 其值（用于表示整数）为`digit`的基本码点，需要在`0`到`base - 1`范围内。
 *                   如果`flag`非零，则使用大写形式；否则使用小写形式。
 *                   如果`flag`非零且`digit`没有大写形式，则行为未定义。
 */
function digitToBasic(digit, flag) {
    return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
}

/**
 * 根据 RFC 3492 第 3.4 节的偏差适应函数。
 * https://tools.ietf.org/html/rfc3492#section-3.4
 * @private
 */
function adapt(delta, numPoints, firstTime) {
    let k = 0;
    delta = firstTime ? floor(delta / damp) : delta >> 1; // 首次处理时除以阻尼因子，否则右移一位
    delta += floor(delta / numPoints);
    for (; /* 无初始化 */ delta > (baseMinusTMin * tMax) >> 1; k += base) {
        delta = floor(delta / baseMinusTMin);
    }
    return floor(k + ((baseMinusTMin + 1) * delta) / (delta + skew));
}

/**
 * 将仅包含ASCII符号的Punycode字符串转换为Unicode符号字符串。
 * @memberOf punycode
 * @param {String} input 仅包含ASCII符号的Punycode字符串
 * @returns {String} 生成的Unicode符号字符串
 */
function decode(input) {
    // 不使用UCS-2。
    const output = [];
    const inputLen = input.length;
    let i = 0, n = initialN, bias = initialBias;

    // 处理基本码点：让`basic`为最后一个分隔符之前的输入码点数量，如果没有则为`0`，然后将前几个基本码点复制到输出。
    let basic = input.lastIndexOf(delimiter);
    if (basic < 0) basic = 0;

    for (let j = 0; j < basic; ++j) {
        // 如果不是基本码点,则抛出错误
        if (input.charCodeAt(j) >= 0x80) error('not-basic');
        output.push(input.charCodeAt(j));
    }

    // 主解码循环：如果有基本码点被复制，则从最后一个分隔符之后开始；否则从头开始。
    for (let index = basic > 0 ? basic + 1 : 0; index < inputLen /* 无最终表达式 */;) {
        // `index` 是要消耗的下一个字符的索引。将广义可变长度整数解码为 `delta`，然后将其加到 `i` 上。
        // 如果我们随着处理增加 `i`，然后在最后减去其起始值以获得 `delta`，则溢出检查更容易。
        const oldi = i;
        for (let w = 1, k = base /* 无条件 */; ; k += base) {
            if (index >= inputLen) error('invalid-input');

            const digit = basicToDigit(input.charCodeAt(index++));
            if (digit >= base) error('invalid-input');
            if (digit > floor((maxInt - i) / w)) error('overflow');

            i += digit * w;
            const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
            if (digit < t) break;

            const baseMinusT = base - t;
            if (w > floor(maxInt / baseMinusT)) error('overflow');
            w *= baseMinusT;
        }

        const out = output.length + 1;
        bias = adapt(i - oldi, out, oldi == 0);

        // `i` 应该从 `out` 回绕到 `0`，每次递增 `n`，所以我们现在修复它：
        if (floor(i / out) > maxInt - n) error('overflow')

        n += floor(i / out);
        i %= out;

        // 在输出的位置 `i` 插入 `n`。
        output.splice(i++, 0, n);
    }

    return String.fromCodePoint(...output);
}

/**
 * 将Unicode符号字符串（例如域名标签）转换为仅包含ASCII符号的Punycode字符串。
 * @memberOf punycode
 * @param {String} input Unicode符号字符串
 * @returns {String} 生成的仅包含ASCII符号的Punycode字符串
 */
function encode(input) {
    input = ucs2decode(input);                        // 将UCS-2输入转换为Unicode码点数组。
    const output = [];
    const inputLen = input.length;                    // 缓存长度
    let n = initialN, delta = 0, bias = initialBias;  // 初始化状态

    // 处理基本码点。
    for (const currentValue of input) {
        if (currentValue < 0x80) output.push(strFromCharCode(currentValue));
    }

    const basicLen = output.length;
    let handledCPCount = basicLen;

    // `handledCPCount`是已处理的码点数量;`basicLength` 是基本码点的数量。

    // 用分隔符结束基本字符串，除非它是空的。
    if (basicLen) output.push(delimiter);

    // 主编码循环：
    while (handledCPCount < inputLen) {
        // 所有小于 n 的非基本码点都已处理。找到下一个更大的：
        let m = maxInt;
        for (const currentValue of input) {
            if (currentValue >= n && currentValue < m) m = currentValue;
        }

        // 增加 `delta` 足够多，以将解码器的 <n,i> 状态推进到 <m,0>，但要防止溢出。
        const handledCPCountPlusOne = handledCPCount + 1;
        if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) error('overflow');

        delta += (m - n) * handledCPCountPlusOne;
        n = m;

        for (const currentValue of input) {
            if (currentValue < n && ++delta > maxInt) error('overflow');

            if (currentValue === n) {
                // 将 delta 表示为广义可变长度整数。
                let q = delta;
                for (let k = base /* 无条件 */; ; k += base) {
                    const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
                    if (q < t) break;

                    const qMinusT = q - t;
                    const baseMinusT = base - t;
                    output.push(strFromCharCode(digitToBasic(t + (qMinusT % baseMinusT), 0)));
                    q = floor(qMinusT / baseMinusT);
                }

                output.push(strFromCharCode(digitToBasic(q, 0)));
                bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLen);
                delta = 0;
                ++handledCPCount;
            }
        }

        ++delta;
        ++n;
    }
    return output.join('');
}

/**
 * 将表示域名或电子邮件地址的Punycode字符串转换为Unicode。
 * 只有输入的Punycode部分会被转换，即如果你在已经转换为Unicode的字符串上调用它也没有关系。
 * @memberOf punycode
 * @param {String} input 要转换为Unicode的Punycode编码的域名或电子邮件地址
 * @returns {String} 给定Punycode字符串的Unicode表示
 */
function toUnicode(input) {
    return mapDomain(input, function (string) {
        return regexs.PUNYCODE.test(string) ? decode(string.slice(4).toLowerCase()) : string;
    });
}

/**
 * 将表示域名或电子邮件地址的Unicode字符串转换为Punycode。
 * 只有域名的非ASCII部分会被转换，即如果你使用已经是ASCII的域名调用它也没有关系。
 * @memberOf punycode
 * @param {String} input 要转换的域名或电子邮件地址，作为Unicode字符串
 * @returns {String} 给定域名或电子邮件地址的Punycode表示
 */
function toASCII(input) {
    return mapDomain(input, function (string) {
        return regexs.NON_BASIC_ASCII.test(string) ? 'xn--' + encode(string) : string;
    });
}

/*--------------------------------------------------------------------------*/
// 导出punycode结构内容
// version: '2.3.1', // Punycode.js版本号 <https://mathiasbynens.be/notes/javascript-encoding>
// ucs2decode,
// ucs2encode,
// decode,
// encode,
// toUnicode,
module.exports = { toASCII };