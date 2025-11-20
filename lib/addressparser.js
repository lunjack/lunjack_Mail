'use strict';

const { regexs } = require('./regexs');

/**
 * 如果文本数据为空但存在注释数据，则用注释数据替换文本数据
 * @param {Object} data 包含文本和注释数据的对象
 * @return {Object} 处理后的数据对象
 */
function _replaceTextWithComment(data) {
    if (!data.text.length && data.comment.length) data.text = data.comment, data.comment = [];
    return data;
}

/**
 * 从文本数据中检测并提取电子邮件地址
 * @param {Object} data 包含地址和文本数据的对象
 */
function _extractEmailFromText(data) {
    let foundAddress = false;
    const { text } = data,
        regexHandler = address => {
            if (!foundAddress) {
                data.address = [address.trim()], foundAddress = true;
                return ' ';
            }
            return address;
        };

    // 从后向前遍历文本数据，检测电子邮件地址
    for (let i = text.length - 1; i >= 0; i--) {
        const currentText = text[i];
        // 先尝试精确匹配标准电子邮件格式
        if (currentText.match(regexs.EMAIL_EXACT)) {
            data.address = text.splice(i, 1), foundAddress = true;
            break;
        }

        // 如果精确匹配失败，尝试使用正则表达式处理可能包含特殊字符的邮件地址
        if (!foundAddress) {
            text[i] = currentText.replace(regexs.EMAIL_LOOSE, regexHandler).trim();
            if (foundAddress) break;
        }
    }
}

/**
 * 将单个地址的令牌转换为地址对象
 * @param {Array} tokens 令牌对象数组
 * @return {Array} 地址对象数组
 */
function _handleAddress(tokens) {
    let isGroup = false, state = 'text';
    const data = { address: [], comment: [], group: [], text: [] };

    // 解析令牌，分类到地址、注释、组或文本
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i], prevToken = i ? tokens[i - 1] : null;
        if (token.type === 'operator')
            switch (token.value) {
                case '<':
                    state = 'address';
                    break;
                case '(':
                    state = 'comment';
                    break;
                case ':':
                    state = 'group';
                    isGroup = true;
                    break;
                default:
                    state = 'text';
                    break;
            }
        else if (token.value) {
            // 清理地址令牌中的多余字符(如未引用的名称中的"<")
            if (state === 'address') token.value = token.value.replace(regexs.ADDRESS_CLEAN, '');

            // 如果前一个令牌设置了noBreak，则附加到最后一个元素,否则创建新的元素
            const dLen = data[state].length;
            prevToken?.noBreak && dLen ? data[state][dLen - 1] += token.value : data[state].push(token.value);
        }
    }
    const { text, group, address } = _replaceTextWithComment(data);             // 如果没有文本但有注释，用注释替换文本
    // 如果组存在，处理组地址：组名和组成员列表
    if (isGroup) return [{ name: text.join(' ') || '', group: group.length ? addressparser(group.join(',')) : [] }];
    else {
        if (!address.length && text.length) _extractEmailFromText(data);         // 如果没有地址，从文本中提取电子邮件地址

        const { text: newTxt, address: newAdd } = _replaceTextWithComment(data); // 再次检查是否需要将注释转换为文本
        if (newAdd.length > 1) newTxt.push(...newAdd.splice(1));                 // 如果找到多个地址,只保留第一个,其余的转到文本数组
        const addressText = newTxt.join(' ').trim(), addressValue = newAdd.join(' ').trim(),// 合并文本和地址数据
            // 创建地址对象
            addressArr = { address: addressValue || addressText || '', name: addressText || addressValue || '' };

        // 如果地址和名称相同，根据内容决定清除哪个(如果是邮件地址,清除名称,否则,清除地址)
        if (addressArr.address === addressArr.name)
            addressArr.address.includes('@') ? addressArr.name = '' : addressArr.address = '';

        return [addressArr];
    }
}

/**
 * 用于标记地址字段字符串的标记器
 * @constructor
 * @param {String} str 需要解析的地址字段字符串
 */
class Tokenizer {
    constructor(str = '') {
        this.str = str.toString(), this.operatorExpecting = '', this.node = null, this.escaped = false, this.list = [];

        // 操作符映射：开始操作符到期望的结束操作符(引号,注释,邮件地址,地址分隔符,组定义开始,组定义结束)
        this.operators = { '"': '"', '(': ')', '<': '>', ',': '', ':': ';', ';': '' };
    }

    /**
     * 将输入字符串标记化为操作符和文本令牌
     * @return {Array} 令牌对象数组
     */
    tokenize() {
        const list = [];

        for (let i = 0, len = this.str.length; i < len; i++) {
            const chr = this.str.charAt(i), nextChr = i < len - 1 ? this.str.charAt(i + 1) : null;
            this._processChar(chr, nextChr);
        }

        // 过滤并清理令牌
        this.list.forEach(node => {
            node.value = (node.value || '').toString().trim();
            if (node.value) list.push(node); // 忽略空文本节点
        });

        return list;
    }

    /**
     * 处理单个字符，识别操作符或文本内容
     * @param {String} chr 当前字符
     * @param {String} nextChr 下一个字符（用于前瞻）
     */
    _processChar(chr, nextChr) {
        const { escaped, operatorExpecting: oExpecting, operators } = this;
        // 检查是否是期望的结束操作符
        if (!escaped && chr === oExpecting) return this._addOperatorToken(chr, nextChr);

        // 检查是否是新的开始操作符
        else if (!escaped && !oExpecting && chr in operators) return this._addOperatorToken(chr, nextChr, operators[chr]);

        // 检查转义字符（在引号或注释中）
        else if (!escaped && ['"', "'"].includes(oExpecting) && chr === '\\') return this.escaped = true;
        this._addTextChar(chr), this.escaped = false;  // 处理文本字符并重置转义标志
    }

    /**
     * 添加操作符令牌到列表
     * @param {String} chr 操作符字符
     * @param {String} nextChr 下一个字符（用于设置noBreak标志）
     * @param {String} newExpecting 新的期望操作符
     */
    _addOperatorToken(chr, nextChr, newExpecting = '') {
        const node = { type: 'operator', value: chr };
        // 如果下一个字符不是空白或分隔符，设置noBreak标志
        if (nextChr && ![' ', '\t', '\r', '\n', ',', ';'].includes(nextChr)) node.noBreak = true;
        this.list.push(node), this.node = null, this.escaped = false, this.operatorExpecting = newExpecting;
    }

    /**
     * 添加文本字符到当前文本节点
     * @param {String} chr 文本字符
     */
    _addTextChar(chr) {
        if (!this.node) this.node = { type: 'text', value: '' }, this.list.push(this.node); // 如果没有当前文本节点,则创建一个新的

        const processedChr = chr === '\n' ? ' ' : chr; // 规范化空白字符
        if (chr.charCodeAt(0) >= 0x21 || [' ', '\t'].includes(chr)) this.node.value += processedChr;// 如果是可见字符或空格,则添加
    }
}

/**
 * 解析地址字段字符串为结构化的电子邮件地址对象数组
 *
 * 示例:
 *   '姓名 <user@example.com>'
 *   转换为 [{name: '姓名', address: 'user@example.com'}]
 *
 * 支持:
 *   - 单个地址: 'user@example.com'
 *   - 带姓名地址: '姓名 <user@example.com>'
 *   - 带注释地址: '姓名 (注释) <user@example.com>'
 *   - 地址组: '组名: member1@example.com, member2@example.com;'
 *
 * @param {String} str 需要解析的地址字段字符串
 * @param {Object} options 解析选项
 * @param {Boolean} options.flatten 是否将组地址展平为单个地址列表
 * @return {Array} 地址对象数组
 */
function addressparser(str, options = {}) {
    const tokenizer = new Tokenizer(str), tokens = tokenizer.tokenize(), addresses = [];
    let currentAddress = [];

    // 根据分隔符将令牌分组为各个地址
    tokens.forEach(token => {
        if (token.type === 'operator' && [',', ';'].includes(token.value)) {
            if (currentAddress.length) addresses.push(currentAddress);
            currentAddress = [];
        }
        else currentAddress.push(token);
    });

    if (currentAddress.length) addresses.push(currentAddress);  // 处理最后一个地址
    let parsedAddresses = []; // 解析每个地址组
    addresses.forEach(addressTokens => {
        const address = _handleAddress(addressTokens);
        if (address.length) parsedAddresses = parsedAddresses.concat(address);
    });

    // 如果要求展平，将组地址转换为平面列表
    if (options.flatten) {
        const flattenedAddresses = [],
            walkAddressList = list => {
                list.forEach(({ group, ...address }) => group ? walkAddressList(group) : flattenedAddresses.push(address));
            };

        walkAddressList(parsedAddresses);
        return flattenedAddresses;
    }

    return parsedAddresses;
}

// 导出
module.exports = addressparser;