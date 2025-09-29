/* eslint quote-props: 0 */

'use strict';

const path = require('path');

// 默认的MIME类型
const defaultMimeType = 'application/octet-stream';
// 默认的文件扩展名
const defaultExtension = 'bin';

// MIME类型到文件扩展名的映射表
const mimeTypes = new Map([
    ['application/acad', 'dwg'],  // AutoCAD文档
    ['application/applixware', 'aw'],  // Applixware文件
    ['application/arj', 'arj'],  // ARJ压缩文件
    ['application/atom+xml', 'xml'],  // Atom订阅格式
    ['application/atomcat+xml', 'atomcat'],  // Atom分类格式
    ['application/atomsvc+xml', 'atomsvc'],  // Atom服务文档
    ['application/base64', ['mm', 'mme']],  // Base64编码文件，支持多种扩展名
    ['application/binhex', 'hqx'],  // BinHex编码文件
    ['application/binhex4', 'hqx'],  // BinHex4编码文件
    ['application/book', ['book', 'boo']],  // 图书文件
    ['application/ccxml+xml,', 'ccxml'],  // CCXML语音文件
    ['application/cdf', 'cdf'],  // 频道定义格式文件
    // 其它MIME类型映射...
]);

// 文件扩展名到MIME类型的映射表
const extensions = new Map([
    ['123', 'application/vnd.lotus-1-2-3'],  // Lotus 1-2-3电子表格
    ['323', 'text/h323'],  // H.323视频会议
    ['*', 'application/octet-stream'],  // 默认二进制流
    ['3dm', 'x-world/x-3dmf'],  // 3D模型文件
    ['3dmf', 'x-world/x-3dmf'],  // 3D模型文件格式
    ['3dml', 'text/vnd.in3d.3dml'],  // 3D标记语言
    ['3g2', 'video/3gpp2'],  // 3GPP2视频格式
    ['3gp', 'video/3gpp'],  // 3GPP视频格式
    ['7z', 'application/x-7z-compressed'],  // 7-Zip压缩文件
    ['a', 'application/octet-stream'],  // 静态库文件
    ['aab', 'application/x-authorware-bin'],  // Authorware二进制文件
    ['aac', 'audio/x-aac'],  // AAC音频文件
    ['aam', 'application/x-authorware-map'],  // Authorware映射文件
    ['aas', 'application/x-authorware-seg']  // Authorware片段文件
    // 其它扩展名映射...
]);

module.exports = {
    /**
     * 根据文件名检测MIME类型
     * @param {string} filename - 要检测的文件名
     * @returns {string} 检测到的MIME类型
     */
    detectMimeType(filename) {
        // 如果文件名为空，返回默认MIME类型
        if (!filename) {
            return defaultMimeType;
        }

        // 解析文件路径获取扩展名
        let parsed = path.parse(filename);
        // 提取扩展名（去掉点号），处理查询参数，转换为小写
        let extension = (parsed.ext.substr(1) || parsed.name || '').split('?').shift().trim().toLowerCase();
        let value = defaultMimeType;

        // 如果在扩展名映射表中找到对应项，使用对应的MIME类型
        if (extensions.has(extension)) {
            value = extensions.get(extension);
        }

        // 如果值是数组，返回第一个元素
        if (Array.isArray(value)) {
            return value[0];
        }
        return value;
    },

    /**
     * 根据MIME类型检测文件扩展名
     * @param {string} mimeType - 要检测的MIME类型
     * @returns {string} 检测到的文件扩展名
     */
    detectExtension(mimeType) {
        // 如果MIME类型为空，返回默认扩展名
        if (!mimeType) {
            return defaultExtension;
        }

        // 处理MIME类型字符串：转换为小写，分割类型和子类型
        let parts = (mimeType || '').toLowerCase().trim().split('/');
        let rootType = parts.shift().trim();  // 主类型（如：application、text等）
        let subType = parts.join('/').trim();  // 子类型

        // 构建完整的MIME类型并查找对应的扩展名
        let fullMimeType = rootType + '/' + subType;
        if (mimeTypes.has(fullMimeType)) {
            let value = mimeTypes.get(fullMimeType);
            // 如果值是数组，返回第一个元素
            if (Array.isArray(value)) {
                return value[0];
            }
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
};