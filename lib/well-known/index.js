'use strict';

// 导入服务配置文件
const SERVICES = require('./services.json');
const { regexs, resetRegex } = require('../regexs');

const normalized = {}; // 创建规范化后的服务对象

// 遍历所有服务键名
Object.keys(SERVICES).forEach(key => {
    const service = SERVICES[key];

    // 为指定键添加规范化服务条目
    function addServiceEntry(sourceKey) {
        normalized[normalizeKey(sourceKey)] = normalizeService(service);
    };
    // 处理主键,别名,域名
    addServiceEntry(key), (service.aliases ?? []).forEach(addServiceEntry), (service.domains ?? []).forEach(addServiceEntry);
});

/**
 * 规范化键名
 * 移除非字母数字、点号和连字符的字符，并转换为小写
 * @param {String} key - 需要规范化的键名
 * @returns {String} 规范化后的键名
 */
function normalizeKey(key) {
    const rNADH = resetRegex(regexs.NON_ALPHANUMERIC_DOT_HYPHEN);
    return key.replace(rNADH, '').toLowerCase();
}

/**
 * 规范化服务对象
 * 过滤掉不需要的字段（domains 和 aliases）
 * @param {Object} service - 原始服务对象
 * @returns {Object} 规范化后的服务对象
 */
function normalizeService(service) {
    const filter = ['domains', 'aliases']; // 需要过滤的字段
    return Object.fromEntries(
        Object.entries(service).filter(([key]) => !filter.includes(key)) // 只保留不在过滤列表中的属性
    );
}

/**
 * 根据提供的键名解析 SMTP 配置
 * 键名可以是服务名称（如 'Gmail'）、别名（如 'Google Mail'）或邮箱地址（如 'test@googlemail.com'）
 * @param {String} key - 服务名称、别名或邮箱地址
 * @returns {Object|Boolean} SMTP 配置对象，如果未找到则返回 false
 */
module.exports = function (key) {
    key = normalizeKey(key.split('@').pop()); // 如果是邮箱地址，提取域名部分并规范化
    return normalized[key] || false;          // 返回对应的配置对象，未找到则返回 false
};