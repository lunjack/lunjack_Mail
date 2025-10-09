'use strict';

const path = require('path');
const { MIME_TYPES, EXTENSIONS } = require('./mime-types');
const { regexs, resetRegex } = require('../regexs');
const { base64Encode } = require('../base64');
const { qpEncode } = require('../qp');

const defaultMimeType = 'application/octet-stream'; // 默认的MIME类型(通用的二进制数据流)
const defaultExtension = 'bin'; // 默认的文件扩展名

/**
 * 检查值是否为纯文本字符串（仅使用可打印的7位字符）
 * 允许的控制字符：\x09（制表符）、\x0a（换行符）、\x0d（回车符）、可打印ASCII(\x20-\x7e)
 * 排除: 其他控制字符和DEL, 非ASCII字符
 * @param {String} value 要测试的字符串
 * @param {Boolean} isParam 是否为参数
 * @returns {Boolean} 如果是纯文本字符串则返回true
 */
function isPlainText(value, isParam) {
    // 如果是参数，则允许双引号，否则不允许
    const re = isParam ? regexs.PARAM_PLAIN_TEXT : regexs.PLAIN_TEXT;
    return typeof value === 'string' && !re.test(value);
}

/**
 * 检查多行字符串是否包含超过指定长度的行
 *
 * 用于检测邮件消息是否需要任何处理 -
 * 如果仅使用纯文本字符且行较短，则无需以任何方式编码值。
 * 如果值是纯文本但有超过允许长度的行，则使用format=flowed
 *
 * @param {String} str 要检查的字符串
 * @param {Number} lineLength 要检查的最大行长度
 * @returns {Boolean} 如果至少有一行超过lineLength个字符则返回true
 */
function hasLongerLines(str, lineLength) {
    if (str.length > 128 * 1024) return true;  // 不测试超过128kB的字符串
    return new RegExp('^.{' + (lineLength + 1) + ',}', 'm').test(str);
}

/**
 * 将字符串或Buffer编码为UTF-8 MIME字（rfc2047）
 *
 * @param {String|Buffer} data 要编码的字符串
 * @param {String} mimeWordEncoding='Q' MIME字的编码，Q或B
 * @param {Number} [maxLength=0] 如果设置，根据需要将MIME字拆分为多个块
 * @return {String} 单个或多个连接在一起的MIME字
 */
function encodeWord(data, mimeWordEncoding, maxLength) {
    mimeWordEncoding = (mimeWordEncoding || 'Q').toString().toUpperCase().trim().charAt(0);
    maxLength = maxLength || 0;

    let encodedStr;
    let toCharset = 'UTF-8';
    const offset = 7 + toCharset.length;
    // 如果最大长度大于7 + toCharset.length，则减去7 + toCharset.length
    maxLength && maxLength > offset && (maxLength -= offset);

    // 如果mimeWordEncoding为Q，则使用qp编码，否则使用base64编码
    if (mimeWordEncoding === 'Q') {
        resetRegex(regexs.NON_SAFE_CHAR);
        encodedStr = qpEncode(data).replace(regexs.NON_SAFE_CHAR, chr => {
            let ord = chr.charCodeAt(0).toString(16).toUpperCase();
            if (chr === ' ') return '_'; // 如果字符是空格，则使用_
            else return '=' + (ord.length === 1 ? '0' + ord : ord); // 否则使用=XX
        });

    }
    // 否则如果mimeWordEncoding为B，则使用base64编码
    else if (mimeWordEncoding === 'B') {
        encodedStr = typeof data === 'string' ? data : base64Encode(data);
        maxLength = maxLength ? Math.max(3, ((maxLength - (maxLength % 4)) / 4) * 3) : 0;
    }

    if (maxLength && encodedStr.length > maxLength) {
        if (mimeWordEncoding === 'Q')
            encodedStr = _splitMimeEncodedString(encodedStr, maxLength).join('?= =?' + toCharset + '?' + mimeWordEncoding + '?');
        else {
            let parts = [];
            let lpart = '';
            for (let i = 0, len = encodedStr.length; i < len; i++) {
                let chr = encodedStr.charAt(i);
                // 如果字符是emoji，则将下一个字符也添加到字符串中
                if (regexs.EMOJI_OR_SURROGATE.test(chr) && i < len - 1) chr += encodedStr.charAt(++i);

                // 如果字符串加上当前字符的长度超过最大长度，则将字符串推送到数组中，并开始一个新的字符串
                if (Buffer.byteLength(lpart + chr) <= maxLength || i === 0) lpart += chr;
                else {
                    // 达到长度限制，推送现有字符串并重新开始
                    parts.push(base64Encode(lpart));
                    lpart = chr;
                }
            }
            if (lpart) parts.push(base64Encode(lpart)); // 如果最后一个字符串不为空，则将其推送到数组中

            // 如果有多个字符串，则将它们连接到一起，并用'?= =?' + toCharset + '?' + mimeWordEncoding + '?'分隔
            if (parts.length > 1) encodedStr = parts.join('?= =?' + toCharset + '?' + mimeWordEncoding + '?');
            else encodedStr = parts.join(''); // 否则，如果只有一个字符串，则将其返回
        }
    }

    // 返回编码后的字符串
    return '=?' + toCharset + '?' + mimeWordEncoding + '?' + encodedStr + (encodedStr.slice(-2) === '?=' ? '' : '?=');
}

/**
 * 查找包含非ASCII文本的单词序列并将其转换为MIME字
 *
 * @param {String} value 要编码的字符串
 * @param {String} mimeWordEncoding='Q' MIME字的编码，Q或B
 * @param {Number} [maxLength=0] 如果设置，根据需要将MIME字拆分为多个块
 * @param {Boolean} [encodeAll=false] 如果为true且值需要编码，则编码整个字符串，而不仅仅是最小匹配
 * @return {String} 可能包含MIME字的字符串
 */
function encodeWords(value, mimeWordEncoding, maxLength, encodeAll) {
    maxLength = maxLength || 0;

    let encodedValue;

    // 查找第一个包含不可打印ASCII或特殊符号的单词
    let firstMatch = value.match(regexs.FIRST_NON_ASCII_WORD);
    if (!firstMatch) return value; // 如果第一个包含为假，则返回原始值

    // 如果请求编码所有内容或字符串包含类似编码字的内容，则编码所有内容
    if (encodeAll) return encodeWord(value, mimeWordEncoding, maxLength);

    // 查找最后一个包含不可打印ASCII的单词
    let lastMatch = value.match(regexs.LAST_NON_ASCII_WORD);
    if (!lastMatch) return value; // 如果最后一个包含为假，则返回原始值

    let startIndex =
        firstMatch.index +
        (
            firstMatch[0].match(regexs.NON_WHITESPACE) || { index: 0 }
        ).index;
    let endIndex = lastMatch.index + (lastMatch[1] || '').length;

    encodedValue =
        (startIndex ? value.substring(0, startIndex) : '') +
        encodeWord(value.substring(startIndex, endIndex), mimeWordEncoding || 'Q', maxLength) +
        (endIndex < value.length ? value.substring(endIndex) : '');

    return encodedValue;
}

/**
 * 将解析后的头值连接为 'value; param1=value1; param2=value2'
 * 注意：我们遵循RFC 822来维护需要放在引号中的特殊字符列表。
 *       参考：https://www.w3.org/Protocols/rfc1341/4_Content-Type.html
 * @param {Object} structured 解析后的头值
 * @return {String} 连接后的头值
 */
function buildHeaderValue(structured) {
    let paramsArray = [];

    Object.keys(structured.params || {}).forEach(param => {
        let pValue = structured.params[param];
        // 如果值是纯文本字符串，则将其编码为MIME字
        if (!isPlainText(pValue, true) || pValue.length >= 75) {
            _buildHeaderParam(param, pValue, 50).forEach(encodedParam => {
                const { key, value } = encodedParam;
                // 如果参数值安全 或 参数是编码后的字符串,则不编码
                if (!regexs.UNSAFE_HEADER_PARAM.test(value) || key.slice(-1) === '*')
                    paramsArray.push(key + '=' + value);
                // 否则将参数编码为JSON字符串
                else paramsArray.push(key + '=' + JSON.stringify(value));
            });
        }
        // 否则如果值是纯文本字符串，则将其编码为JSON字符串
        else if (regexs.UNSAFE_PARAM_VALUE.test(pValue)) paramsArray.push(param + '=' + JSON.stringify(pValue));
        else paramsArray.push(param + '=' + pValue); // 否则，如果值是安全的，则将其编码为MIME字
    });

    return structured.value + (paramsArray.length ? '; ' + paramsArray.join('; ') : '');
}

/**
 * 将带有key=value参数的头值解析为结构化对
 *
 * parseHeaderValue('content-type: text/plain; CHARSET='UTF-8'') ->
 * {
 *   'value': 'text/plain',
 *   'params': {
 *     'charset': 'UTF-8'
 *   }
 * }
 *
 * @param {String} str 头值
 * @return {Object} 头值作为解析后的结构
 */
function parseHeaderValue(str) {
    const result = {
        value: '',
        params: {}
    };

    if (!str || typeof str !== 'string') {
        return result;
    }

    let state = 'value'; // 'value' | 'key' | 'quoted'
    let currentKey = '';
    let currentValue = '';
    let quoteChar = '';
    let escaped = false;

    for (let i = 0; i < str.length; i++) {
        const char = str[i];

        if (escaped) {
            currentValue += char;
            escaped = false;
            continue;
        }

        switch (state) {
            case 'value':
                if (char === ';') {
                    // 结束主值，开始参数
                    result.value = currentValue.trim();
                    currentValue = '';
                    state = 'key';
                } else if (char === '\\') {
                    escaped = true;
                } else {
                    currentValue += char;
                }
                break;

            case 'key':
                if (char === '=') {
                    // 键结束，开始值
                    currentKey = currentValue.trim().toLowerCase();
                    currentValue = '';
                    state = 'value';
                } else if (char === ';') {
                    // 没有值的参数
                    if (currentValue.trim()) {
                        result.params[currentValue.trim().toLowerCase()] = '';
                    }
                    currentValue = '';
                } else {
                    currentValue += char;
                }
                break;

            case 'quoted':
                if (char === quoteChar) {
                    state = 'value';
                } else if (char === '\\') {
                    escaped = true;
                } else {
                    currentValue += char;
                }
                break;
        }

        // 处理引号开始（不在转义状态下）
        if (!escaped && (char === '"' || char === "'") && state !== 'quoted') {
            quoteChar = char;
            state = 'quoted';
        }
    }

    // 处理最后剩余的值
    const finalValue = currentValue.trim();
    if (state === 'value' && finalValue) {
        if (!result.value && !currentKey) {
            result.value = finalValue;
        } else if (currentKey) {
            result.params[currentKey] = finalValue;
        }
    } else if (state === 'key' && finalValue) {
        result.params[finalValue.toLowerCase()] = '';
    }

    // 处理 RFC2231 编码的参数
    _processRFC2231Params(result.params);

    return result;
}

/**
 * 处理 RFC2231 编码的参数
 * 将拆分的rfc2231字符串合并到单个键中，并进行解码
 * @param {Object} params 参数对象
 */
function _processRFC2231Params(params) {
    // 将拆分的rfc2231字符串合并到单个键中
    Object.keys(params).forEach(key => {
        let actualKey, nr, match, value;
        if ((match = key.match(regexs.RFC2231_KEY))) {
            actualKey = key.substring(0, match.index);
            nr = Number(match[2] || match[3]) || 0;

            if (!params[actualKey] || typeof params[actualKey] !== 'object')
                params[actualKey] = {
                    charset: false,
                    values: []
                };

            value = params[key];

            if (nr === 0 && match[0].slice(-1) === '*' && (match = value.match(regexs.CHARSET_LANGUAGE_VALUE))) {
                params[actualKey].charset = match[1] || 'iso-8859-1';
                value = match[2];
            }

            params[actualKey].values[nr] = value;
            delete params[key]; // 删除旧引用
        }
    });

    // 连接拆分的rfc2231字符串并将编码字符串转换为MIME编码字
    Object.keys(params).forEach(key => {
        let value;
        if (params[key] && Array.isArray(params[key].values)) {
            value = params[key].values.map(val => val || '').join('');

            if (params[key].charset) {
                resetRegex(regexs.RFC2231_SPECIAL_CHARS);
                // 将"%AB"转换为"=?charset?Q?=AB?="
                params[key] = '=?' + params[key].charset + '?Q?' + value
                    // 修复无效编码的字符
                    .replace(regexs.RFC2231_SPECIAL_CHARS, s => {
                        let c = s.charCodeAt(0).toString(16);
                        if (s === ' ') return '_';
                        else return '%' + (c.length < 2 ? '0' : '') + c;
                    })
                    // 从URL编码更改为百分比编码
                    .replace(/%/g, '=') + '?=';
            }
            else params[key] = value;
        }
    });
}

/**
 * 根据文件名检测MIME类型
 * @param {string} filename - 要检测的文件名
 * @returns {string} 检测到的MIME类型
 */
function detectMimeType(filename) {
    // 如果文件名为空，返回默认MIME类型
    if (!filename) return defaultMimeType;

    // 解析文件路径获取扩展名
    let parsed = path.parse(filename);
    // 提取扩展名（去掉点号），处理查询参数，转换为小写
    let extension = (parsed.ext.substring(1) || parsed.name || '').split('?').shift().trim().toLowerCase();
    let value = defaultMimeType;

    // 如果在扩展名映射表中找到对应项，则使用对应的MIME类型
    if (EXTENSIONS.has(extension)) value = EXTENSIONS.get(extension);

    // 如果值是数组，返回第一个元素
    if (Array.isArray(value)) return value[0];

    return value;
}

/**
 * 根据MIME类型检测文件扩展名
 * @param {string} mimeType - 要检测的MIME类型
 * @returns {string} 检测到的文件扩展名
 */
function detectExtension(mimeType) {
    // 如果MIME类型为空，返回默认扩展名
    if (!mimeType) return defaultExtension;

    // 处理MIME类型字符串：转换为小写，分割类型和子类型
    let parts = (mimeType || '').toLowerCase().trim().split('/');
    let rootType = parts.shift().trim();  // 主类型（如：application、text等）
    let subType = parts.join('/').trim();  // 子类型

    // 构建完整的MIME类型并查找对应的扩展名
    let fullMimeType = rootType + '/' + subType;
    if (MIME_TYPES.has(fullMimeType)) {
        let value = MIME_TYPES.get(fullMimeType);
        // 如果值是数组，返回第一个元素
        if (Array.isArray(value)) return value[0];
        return value;
    }

    // 根据主类型返回默认扩展名
    switch (rootType) {
        case 'text':  // 文本类型默认返回txt
            return 'txt';
        default:  // 其他类型默认返回bin
            return 'bin';
    }
}

/**
 * 折叠长行，适用于折叠头行（afterSpace=false）和
 * 流文本（afterSpace=true）
 *
 * @param {String} str 要折叠的字符串
 * @param {Number} [lineLength=76] 一行的最大长度
 * @param {Boolean} afterSpace 如果为true，在行尾留一个空格
 * @return {String} 带有折叠行的字符串
 */
function foldLines(str, lineLength, afterSpace) {
    str = (str || '').toString();
    lineLength = lineLength || 76;

    let pos = 0,
        len = str.length,
        result = '',
        line,
        match;

    while (pos < len) {
        line = str.substring(pos, pos + lineLength);
        if (line.length < lineLength) {
            result += line;
            break;
        }
        if ((match = line.match(regexs.LINE_BREAK))) {
            line = match[0];
            result += line;
            pos += line.length;
            continue;
        }
        else if ((match = line.match(regexs.TRAILING_SPACES)) && match[0].length - (afterSpace ? (match[1] || '').length : 0) < line.length)
            line = line.substring(0, line.length - (match[0].length - (afterSpace ? (match[1] || '').length : 0)));
        else if ((match = str.substring(pos + line.length).match(regexs.NEXT_WORD)))
            line = line + match[0].substring(0, match[0].length - (!afterSpace ? (match[1] || '').length : 0));

        result += line;
        pos += line.length;
        if (pos < len) result += '\r\n'
    }

    return result;
}

/**
 * 将字符串或Buffer编码为UTF-8参数值连续编码（rfc2231）
 * 用于拆分长参数值。
 *
 * 例如
 *      title="unicode string"
 * 变为
 *     title*0*=utf-8''unicode
 *     title*1*=%20string
 *
 * @param {String} key 参数键
 * @param {String|Buffer} data 要编码的字符串
 * @param {Number} [maxLength=50] 生成块的最大长度
 * @return {Array} 编码键和头的列表
 */
function _buildHeaderParam(key, data, maxLength) {
    let list = [];
    let encodedStr = typeof data === 'string' ? data : (data || '').toString();
    let encodedStrArr;
    let chr, ord;
    let line;
    let startPos = 0;
    let i, len;

    maxLength = maxLength || 50;

    // 处理仅ASCII文本
    if (isPlainText(data, true)) {
        // 检查是否需要转换
        if (encodedStr.length <= maxLength)
            return [
                {
                    key,
                    value: encodedStr
                }
            ];

        encodedStr = encodedStr.replace(new RegExp('.{' + maxLength + '}', 'g'), str => {
            list.push({
                line: str
            });
            return '';
        });

        if (encodedStr) list.push({ line: encodedStr }); // 如果最后一个字符串不为空，则将其推送到数组中
    }
    // 否则，如果字符串包含Unicode或特殊字符，则将其拆分为多个块
    else {
        // 如果字符串包含代理对，则将其规范化为字符数组
        if (regexs.UTF16_HIGH_SURROGATE.test(encodedStr)) {
            encodedStrArr = [];
            for (i = 0, len = encodedStr.length; i < len; i++) {
                chr = encodedStr.charAt(i);
                ord = chr.charCodeAt(0);
                // 如果字符是代理对的第一个字符，则将其与第二个字符一起添加到数组中
                if (ord >= 0xd800 && ord <= 0xdbff && i < len - 1) {
                    chr += encodedStr.charAt(i + 1);
                    encodedStrArr.push(chr);
                    i++;
                }
                else encodedStrArr.push(chr); // 否则,将其添加到数组中
            }
            encodedStr = encodedStrArr;
        }

        // 第一行包含字符集和语言信息，需要编码(即使不包含任何Unicode字符)
        line = "utf-8''";
        let encoded = true;
        startPos = 0;

        // 处理包含Unicode或特殊字符的文本
        for (i = 0, len = encodedStr.length; i < len; i++) {
            chr = encodedStr[i];

            if (encoded) chr = _safeEncodeURIComponent(chr); // 如果需要编码，则对当前字符进行URL编码
            else {
                // 尝试对当前字符进行URL编码
                chr = chr === ' ' ? chr : _safeEncodeURIComponent(chr);
                // 默认情况下不需要编码行，只有当字符串包含Unicode或特殊字符时才需要
                if (chr !== encodedStr[i]) {
                    // 检查是否可以将编码字符添加到行中
                    // 如果不能，则没有理由使用此行，只需将其推送到列表,并开始新行处理需要编码的字符
                    if ((_safeEncodeURIComponent(line) + chr).length >= maxLength) {
                        list.push({
                            line,
                            encoded
                        });
                        line = '';
                        startPos = i - 1;
                    } else {
                        encoded = true;
                        i = startPos;
                        line = '';
                        continue;
                    }
                }
            }

            // 如果行已经太长，将其推送到列表并开始新行
            if ((line + chr).length >= maxLength) {
                list.push({
                    line,
                    encoded
                });
                line = chr = encodedStr[i] === ' ' ? ' ' : _safeEncodeURIComponent(encodedStr[i]);
                if (chr === encodedStr[i]) {
                    encoded = false;
                    startPos = i - 1;
                }
                else encoded = true; // 否则，如果字符串包含Unicode或特殊字符，则需要编码
            }
            else line += chr; // 否则，将字符添加到行中
        }

        // 如果最后一行不为空，则将其推送到列表中
        if (line)
            list.push({
                line,
                encoded
            });
    }

    return list.map((item, i) => ({
        // 如果任何行需要编码，则第一行（part==0）总是编码的
        key: key + '*' + i + (item.encoded ? '*' : ''),
        value: item.line
    }));
}

/**
 * 拆分MIME编码的字符串。用于将MIME字分成更小的块
 *
 * @param {String} str 要拆分的MIME编码字符串
 * @param {Number} maxlen 一个部分的最大字符长度（最小12）
 * @return {Array} 拆分后的字符串
 */
function _splitMimeEncodedString(str, maxlen) {
    let curLine,
        match,
        chr,
        done,
        lines = [];

    // 至少需要12个符号以适应可能的4字节UTF-8序列
    maxlen = Math.max(maxlen || 0, 12);

    while (str.length) {
        curLine = str.substring(0, maxlen);

        // 将不完整的转义字符移回主字符串
        if ((match = curLine.match(regexs.INCOMPLETE_ENCODING_END))) curLine = curLine.substring(0, match.index);

        done = false;
        while (!done) {
            done = true;
            // 检查是否不在Unicode字符序列的中间
            if ((match = str.substring(curLine.length).match(regexs.ENCODED_SEQUENCE))) {
                chr = parseInt(match[1], 16);
                // 无效序列，向后移动一个字符并重新检查
                if (chr < 0xc2 && chr > 0x7f) {
                    curLine = curLine.substring(0, curLine.length - 3);
                    done = false;
                }
            }
        }

        if (curLine.length) lines.push(curLine);

        str = str.substring(curLine.length);
    }

    return lines;
}

/**
 * 对URI字符组件进行编码
 *
 * @param {String} chr 要编码的字符
 * @return {String} 编码后的字符
 */
function _encodeURICharComponent(chr) {
    let res = '';
    let ord = chr.charCodeAt(0).toString(16).toUpperCase();

    if (ord.length % 2) ord = '0' + ord;

    if (ord.length > 2)
        for (let i = 0, len = ord.length / 2; i < len; i++) {
            res += '%' + ord.substring(i * 2, i * 2 + 2);
        }
    else res += '%' + ord;

    return res;
}

/**
 * 安全编码URI组件
 *
 * @param {String} str 要编码的字符串
 * @return {String} 编码后的字符串
 */
function _safeEncodeURIComponent(str) {
    str = (str || '').toString();

    try {
        // 如果尝试编码无效序列（例如部分表情符号），可能会抛出错误
        str = encodeURIComponent(str);
    } catch (E) {
        resetRegex(regexs.NON_SAFE_URI);
        // 返回无效字符的替换字符串
        return str.replace(regexs.NON_SAFE_URI, '');
    }

    resetRegex(regexs.NON_SAFE_URI_CHAR);
    // 确保encodeURIComponent未处理的字符也被转换
    return str.replace(regexs.NON_SAFE_URI_CHAR, chr => _encodeURICharComponent(chr));
}

// 导出
module.exports = {
    isPlainText,
    hasLongerLines,
    encodeWord,
    encodeWords,
    buildHeaderValue,
    parseHeaderValue,
    detectExtension,
    detectMimeType,
    foldLines
};