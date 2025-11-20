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
 * 如果值是纯文本但有超过允许长度的行，则使用format=flowed
 *
 * @param {String} str 要检查的字符串(不检查超过128kB的字符串)
 * @param {Number} lineLength 要检查的最大行长度
 * @returns {Boolean} 如果至少有一行超过lineLength个字符则返回true
 */
function hasLongerLines(str, lineLength) {
    return str.length > 128 * 1024 ? true : new RegExp(`^.{${lineLength + 1},}`, 'm').test(str);
}

/**
 * 将字符串或Buffer编码为UTF-8 MIME字（rfc2047）
 *
 * @param {String|Buffer} data 要编码的字符串
 * @param {String} mimeWordEncoding='Q' MIME字的编码，Q或B
 * @param {Number} [maxLength=0] 如果设置，根据需要将MIME字拆分为多个块
 * @return {String} 单个或多个连接在一起的MIME字
 */
function encodeWord(data, mimeWordEncoding = "Q", maxLength = 0) {
    const newMWE = mimeWordEncoding.toString().toUpperCase().trim().charAt(0);

    let encodedStr;
    const toCharset = 'UTF-8', offset = 7 + toCharset.length;
    maxLength && maxLength > offset && (maxLength -= offset);

    // 如果mimeWordEncoding为Q，则使用qp编码，否则使用base64编码
    if (newMWE === 'Q') {
        const rNSC = resetRegex(regexs.NON_SAFE_CHAR);
        encodedStr = qpEncode(data).replace(rNSC, chr => {
            const ord = chr.charCodeAt(0).toString(16).toUpperCase(), XX = ord.length === 1 ? `0${ord}` : ord
            return chr === ' ' ? '_' : `=${XX}`;// 如果字符是空格，则使用_;否则使用=XX
        });
    }
    // 否则如果mimeWordEncoding为B，则使用base64编码
    else if (newMWE === 'B') {
        encodedStr = typeof data === 'string' ? data : base64Encode(data);
        maxLength = maxLength ? Math.max(3, ((maxLength - (maxLength % 4)) / 4) * 3) : 0;
    }

    if (maxLength && encodedStr.length > maxLength) {
        const delimiter = `?= =?${toCharset}?${newMWE}?`; // 将多个MIME编码字连接起来
        if (newMWE === 'Q') encodedStr = _splitMimeEncodedString(encodedStr, maxLength).join(delimiter);
        else {
            const parts = [];
            let lpart = '';
            for (let i = 0, len = encodedStr.length; i < len; i++) {
                let chr = encodedStr.charAt(i);
                // 如果字符是emoji，则将下一个字符也添加到字符串中
                if (regexs.EMOJI_OR_SURROGATE.test(chr) && i < len - 1) chr += encodedStr.charAt(++i);

                // 如果字符串加上当前字符的长度超过最大长度，则将字符串推送到数组中，并开始一个新的字符串
                if (Buffer.byteLength(lpart + chr) <= maxLength || i === 0) lpart += chr;
                else parts.push(base64Encode(lpart)), lpart = chr;  // 达到长度限制，推送现有字符串并重新开始
            }
            if (lpart) parts.push(base64Encode(lpart));             // 如果最后一个字符串不为空，则将其推送到数组中

            // 如果有多个字符串，则将它们连接到一起，并用分隔符分隔;否则，如果只有一个字符串，则将其返回
            encodedStr = parts.length > 1 ? parts.join(delimiter) : parts.join('');
        }
    }

    return `=?${toCharset}?${newMWE}?${encodedStr}${encodedStr.slice(-2) === '?=' ? '' : '?='}`; // 返回编码后的字符串
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
function encodeWords(value, mimeWordEncoding = "Q", maxLength = 0, encodeAll) {
    // 查找第一个和最后一个是否包含不可打印ASCII或特殊符号的单词,如果找不到，则返回原始值
    const firstMatch = value.match(regexs.FIRST_NON_ASCII_WORD), lastMatch = value.match(regexs.LAST_NON_ASCII_WORD);
    if (!firstMatch || !lastMatch) return value;
    // 如果请求编码所有内容或字符串包含类似编码字的内容，则返回编码后的所有内容
    if (encodeAll) return encodeWord(value, mimeWordEncoding, maxLength);

    const startIndex = firstMatch.index + firstMatch[0].length - firstMatch[0].trimStart().length,
        endIndex = lastMatch.index + (lastMatch[1] || '').length, startStr = startIndex ? value.substring(0, startIndex) : '',
        endStr = endIndex < value.length ? value.substring(endIndex) : '',
        eWord = encodeWords(value.substring(startIndex, endIndex), mimeWordEncoding, maxLength);
    return `${startStr}${eWord}${endStr}`;
}

/**
 * 将解析后的头值连接为 'value; param1=value1; param2=value2'
 * 注意：我们遵循RFC 822来维护需要放在引号中的特殊字符列表。
 *       参考：https://www.w3.org/Protocols/rfc1341/4_Content-Type.html
 * @param {Object} structured 解析后的头值
 * @return {String} 连接后的头值
 */
function buildHeaderValue(structured) {
    const paramsArray = [];
    Object.keys(structured.params || {}).forEach(param => {
        const pValue = structured.params[param];
        // 如果值是纯文本字符串，则将其编码为MIME字
        if (!isPlainText(pValue, true) || pValue.length >= 75) {
            _buildHeaderParam(param, pValue, 50).forEach(encodedParam => {
                const { key, value } = encodedParam;
                // 如果参数值安全或参数是编码后的字符串,则不编码
                if (!regexs.UNSAFE_HEADER_PARAM.test(value) || key.endsWith('*')) paramsArray.push(`${key}=${value}`);
                else paramsArray.push(`${key}=${JSON.stringify(value)}`); // 否则将参数编码为JSON字符串
            });
        }
        // 否则如果值是纯文本字符串，则将其编码为JSON字符串
        else if (regexs.UNSAFE_PARAM_VALUE.test(pValue)) paramsArray.push(`${param}=${JSON.stringify(pValue)}`);
        else paramsArray.push(`${param}=${pValue}`);                    // 否则,如果值是安全的,则将其编码为MIME字
    });

    return structured.value + (paramsArray.length ? `;${paramsArray.join('; ')}` : '');
}

/**
 * 将带有key=value参数的头值解析为结构化对
 *
 * 示例：parseHeaderValue('content-type: text/plain; CHARSET='UTF-8'') ->
 * {
 *   'value': 'text/plain',
 *   'params': {'charset': 'UTF-8'}
 * }
 *
 * @param {String} str 头值
 * @return {Object} 头值作为解析后的结构
 */
function parseHeaderValue(str) {
    const result = { value: '', params: {} };
    if (!str || typeof str !== 'string') return result;  // 输入验证：如果输入为空或不是字符串，直接返回空结果

    // 当前解析状态,正在解析的参数键名,正在解析的值,引号字符,是否处于转义状态
    let state = 'value', currentKey = '', currentValue = '', quoteChar = '', escaped = false;
    // 逐个字符遍历输入字符串
    for (let i = 0; i < str.length; i++) {
        const char = str[i];

        // 处理转义字符：如果前一个字符是\，当前字符直接加入值，不进行特殊处理
        if (escaped) {
            currentValue += char, escaped = false;
            continue;
        }

        // 根据当前状态处理字符
        switch (state) {
            case 'value':  // 解析主值部分（如：text/plain）
                // 如果遇到分号，保存主值(去除前后空格),重置当前值,切换到键解析状态
                if (char === ';') result.value = currentValue.trim(), currentValue = '', state = 'key';
                else if (char === '\\') escaped = true;  // 遇到反斜杠设置转义为真
                else currentValue += char;               // 普通字符：直接添加到当前值
                break;
            case 'key':  // 解析参数键名（如：charset）
                if (char === '=') currentKey = currentValue.trim().toLowerCase(), currentValue = '', state = 'value';
                else if (char === ';') {
                    // 遇到分号但没有等号如：;flag
                    if (currentValue.trim()) result.params[currentValue.trim().toLowerCase()] = '';  // 保存空值参数
                    currentValue = '';
                }
                else currentValue += char;
                break;
            case 'quoted':  // 解析引号内的内容
                if (char === quoteChar) state = 'value';
                else if (char === '\\') escaped = true;
                else currentValue += char;
                break;
        }

        // 检查是否需要进入引号状态（不在转义状态下）
        if (!escaped && (char === '"' || char === "'") && state !== 'quoted') quoteChar = char, state = 'quoted';
    }

    const finalValue = currentValue.trim();                           // 循环结束后，处理最后剩余的值
    // 如果最后为值状态且有值
    if (state === 'value' && finalValue) {
        if (!result.value && !currentKey) result.value = finalValue;  // 如果主值还未设置且没有当前键,设置为主值
        else if (currentKey) result.params[currentKey] = finalValue;  // 如果有当前键,设置为参数值
    }
    // 否则,如果最后在为键状态且有值,设置为空参数
    else if (state === 'key' && finalValue) result.params[finalValue.toLowerCase()] = '';

    _processRFC2231Params(result.params); // 处理 RFC2231 编码的参数（用于邮件头编码）
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
        let match, value;
        if ((match = key.match(regexs.RFC2231_KEY))) {
            const actualKey = key.substring(0, match.index), nr = Number(match[2] || match[3]) || 0;
            if (!params[actualKey] || typeof params[actualKey] !== 'object') params[actualKey] = { charset: false, values: [] };

            value = params[key];
            if (nr === 0 && match[0].endsWith('*') && (match = value.match(regexs.CHARSET_LANGUAGE_VALUE)))
                params[actualKey].charset = match[1] || 'iso-8859-1', value = match[2];

            params[actualKey].values[nr] = value, delete params[key]; // 删除旧引用
        }
    });

    // 连接拆分的rfc2231字符串并将编码字符串转换为MIME编码字
    Object.keys(params).forEach(key => {
        let value;
        if (params[key] && Array.isArray(params[key].values)) {
            value = params[key].values.map(val => val || '').join('');

            if (params[key].charset) {
                const rRSC = resetRegex(regexs.RFC2231_SPECIAL_CHARS);
                // 将"%AB"转换为"=?charset?Q?=AB?="
                params[key] = `=?${params[key].charset}?Q?` + value.replace(rRSC, s => {
                    const c = s.charCodeAt(0).toString(16);
                    return s === ' ' ? '_' : `%${(c.length < 2 ? '0' : '')}${c}`; // 修复无效编码的字符
                }).replace(/%/g, '=') + '?=';                                     // 从URL编码更改为百分比编码
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
    if (!filename) return defaultMimeType; // 如果文件名为空，返回默认MIME类型

    const { ext, name = '' } = path.parse(filename),     // 解析文件路径获取扩展名
        // 提取扩展名（去掉点号），处理查询参数，转换为小写
        extension = (ext.substring(1) || name).split('?').shift().trim().toLowerCase(),

        // 如果在扩展名映射表中找到对应项，则使用对应的MIME类型
        value = EXTENSIONS.has(extension) ? EXTENSIONS.get(extension) : defaultMimeType;
    return Array.isArray(value) ? value[0] : value; // 如果值是数组，返回第一个元素;否则返回值
}

/**
 * 根据MIME类型检测文件扩展名
 * @param {string} mimeType - 要检测的MIME类型
 * @returns {string} 检测到的文件扩展名
 */
function detectExtension(mimeType = '') {
    // 如果MIME类型为空，返回默认扩展名
    if (!mimeType) return defaultExtension;

    // 处理MIME类型字符串:转换为小写,去除空格,按斜杠分割;获取主类型(如：application、text等)和子类型(处理包含斜杠的情况)
    const parts = mimeType.toLowerCase().trim().split('/'), rootType = parts.shift().trim(), subType = parts.join('/').trim(),
        fullMimeType = `${rootType}/${subType}`;         // 重新构建标准化的MIME类型字符串并查找对应的扩展名
    if (MIME_TYPES.has(fullMimeType)) {
        const value = MIME_TYPES.get(fullMimeType);
        return Array.isArray(value) ? value[0] : value;  // 如果值是数组，返回第一个元素
    }

    // 根据主类型返回默认扩展名
    switch (rootType) {
        case 'text': return 'txt'; // 文本类型默认返回txt
        default: return 'bin';     // 其他类型默认返回bin
    }
}

/**
 • 折叠长行，适用于折叠头行（afterSpace=false）和
 • 流文本（afterSpace=true）
 *
 • @param {String} str 要折叠的字符串
 • @param {Number} [lineLength=76] 一行的最大长度
 • @param {Boolean} afterSpace 如果为true，在行尾留一个空格
 • @return {String} 带有折叠行的字符串
 */
function foldLines(str = '', lineLength = 76, afterSpace) {
    // 计算调整长度
    function calculateAdjustment(match, retainSpace) {
        return match[0].length - (retainSpace ? (match[1] || '').length : 0);
    }

    str = str.toString();
    let pos = 0, result = '', line, match;
    const len = str.length;
    while (pos < len) {
        line = str.substring(pos, pos + lineLength);
        if (line.length < lineLength) {
            result += line;
            break;
        }
        if ((match = line.match(regexs.LINE_BREAK))) {
            line = match[0], result += line, pos += line.length;
            continue;
        }
        else if ((match = line.match(regexs.TRAILING_SPACES))) {
            const adjustment = calculateAdjustment(match, afterSpace);
            if (adjustment < line.length) line = line.substring(0, line.length - adjustment);
        }
        else if ((match = str.substring(pos + line.length).match(regexs.NEXT_WORD))) {
            const adjustment = calculateAdjustment(match, !afterSpace);
            line = line + match[0].substring(0, adjustment);
        }

        result += line, pos += line.length;
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
function _buildHeaderParam(key, data = '', maxLength = 50) {
    const list = [];
    let encodedStr = typeof data === 'string' ? data : data.toString();

    // 处理仅ASCII文本
    if (isPlainText(data, true)) {
        if (encodedStr.length <= maxLength) return [{ key, value: encodedStr }]; // 检查是否需要转换
        encodedStr = encodedStr.replace(new RegExp(`.{${maxLength}}`, 'g'), str => {
            list.push({ line: str });
            return '';
        });

        if (encodedStr) list.push({ line: encodedStr }); // 如果最后一个字符串不为空，则将其推送到数组中
    }
    // 否则，如果字符串包含Unicode或特殊字符，则将其拆分为多个块
    else {
        let chr, i, len, line = "utf-8''", encoded = true, startPos = 0;
        // 如果字符串包含代理对，则将其规范化为字符数组
        if (regexs.UTF16_HIGH_SURROGATE.test(encodedStr)) {
            const encodedStrArr = [];
            for (i = 0, len = encodedStr.length; i < len; i++) {
                chr = encodedStr.charAt(i);
                const ord = chr.charCodeAt(0);
                // 如果字符是代理对的第一个字符，则将其与第二个字符一起添加到数组中
                if (ord >= 0xd800 && ord <= 0xdbff && i < len - 1) chr += encodedStr.charAt(i + 1), encodedStrArr.push(chr), i++;
                else encodedStrArr.push(chr); // 否则,将其添加到数组中
            }
            encodedStr = encodedStrArr
        };

        // 处理包含Unicode或特殊字符的文本,第一行包含字符集和语言信息,需要编码(即使不包含任何Unicode字符)
        for (i = 0; i < encodedStr.length; i++) {
            chr = encodedStr[i];
            const encodedChr = _safeEncodeURIComponent(chr);
            if (encoded) chr = encodedChr; // 如果需要编码，则对当前字符进行URL编码
            else {
                chr = chr === ' ' ? chr : encodedChr; // 尝试对当前字符进行URL编码
                // 默认情况下不需要编码行，只有当字符串包含Unicode或特殊字符时才需要
                if (chr !== encodedStr[i]) {
                    // 检查是否可以将编码字符添加到行中
                    // 如果不能，则没有理由使用此行，只需将其推送到列表,并开始新行处理需要编码的字符
                    if ((_safeEncodeURIComponent(line) + chr).length >= maxLength)
                        list.push({ line, encoded }), line = '', startPos = i - 1;
                    else {
                        encoded = true, i = startPos, line = '';
                        continue;
                    }
                }
            }

            // 如果行已经太长，将其推送到列表并开始新行
            if ((line + chr).length >= maxLength) {
                list.push({ line, encoded }), line = chr = encodedStr[i] === ' ' ? ' ' : _safeEncodeURIComponent(encodedStr[i]);
                // 如果添加的字符不需要编码，则将编码设置为false,并继续处理下一个字符;否则设为需要编码
                chr === encodedStr[i] ? (encoded = false, startPos = i - 1) : encoded = true;
            }
            else line += chr;                   // 否则，将字符添加到行中
        }

        if (line) list.push({ line, encoded }); // 如果最后一行不为空，则将其推送到列表中
    }

    // 如果任何行需要编码，则第一行（part==0）总是编码的
    return list.map((item, i) => ({ key: `${key}*${i}${(item.encoded ? '*' : '')}`, value: item.line }));
}

/**
 * 拆分MIME编码的字符串。用于将MIME字分成更小的块
 *
 * @param {String} str 要拆分的MIME编码字符串
 * @param {Number} maxlen 一个部分的最大字符长度（最小12）
 * @return {Array} 拆分后的字符串
 */
function _splitMimeEncodedString(str = '', maxlen) {
    let curLine, match, chr, done;
    const lines = [];

    maxlen = Math.max(maxlen || 0, 12); // 至少需要12个符号以适应可能的4字节UTF-8序列
    while (str.length) {
        curLine = str.substring(0, maxlen);
        // 将不完整的转义字符移回主字符串
        if (match = curLine.match(regexs.INCOMPLETE_ENCODING_END)) curLine = curLine.substring(0, match.index);

        done = false;
        while (!done) {
            done = true;
            // 检查是否不在Unicode字符序列的中间
            if ((match = str.substring(curLine.length).match(regexs.ENCODED_SEQUENCE))) {
                chr = parseInt(match[1], 16);
                // 无效序列，向后移动一个字符并重新检查
                if (chr < 0xc2 && chr > 0x7f) curLine = curLine.substring(0, curLine.length - 3), done = false;
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
    let res = '', ord = chr.charCodeAt(0).toString(16).toUpperCase();

    if (ord.length % 2) ord = `0${ord}`;
    if (ord.length > 2)
        for (let i = 0; i < ord.length / 2; i++) res += `%${ord.substring(i * 2, i * 2 + 2)}`;
    else res += `%${ord}`;

    return res;
}

/**
 * 安全编码URI组件
 *
 * @param {String} str 要编码的字符串
 * @return {String} 编码后的字符串
 */
function _safeEncodeURIComponent(str = '') {
    str = str.toString();

    try {
        str = encodeURIComponent(str); // 尝试使用encodeURIComponent编码字符串
    } catch (E) {
        const rNSU = resetRegex(regexs.NON_SAFE_URI);
        return str.replace(rNSU, '');  // 返回无效字符的替换字符串
    }

    const rNSUC = resetRegex(regexs.NON_SAFE_URI_CHAR);
    return str.replace(rNSUC, chr => _encodeURICharComponent(chr)); // 确保encodeURIComponent未处理的字符也被转换
}

// 导出
module.exports = {
    isPlainText, hasLongerLines, encodeWord,
    encodeWords, buildHeaderValue, parseHeaderValue, detectExtension, detectMimeType, foldLines
};