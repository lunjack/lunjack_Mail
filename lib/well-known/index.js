'use strict';

// 导入服务配置文件
const services = require('./services.json');
const normalized = {}; // 创建规范化后的服务对象

// 遍历所有服务键名
Object.keys(services).forEach(key => {
    let service = services[key];

    // 将主键名规范化后添加到 normalized 对象
    normalized[normalizeKey(key)] = normalizeService(service);

    // 处理服务的别名（aliases）
    [].concat(service.aliases || []).forEach(alias => {
        normalized[normalizeKey(alias)] = normalizeService(service);
    });

    // 处理服务的域名（domains）
    [].concat(service.domains || []).forEach(domain => {
        normalized[normalizeKey(domain)] = normalizeService(service);
    });
});

/**
 * 规范化键名
 * 移除非字母数字、点号和连字符的字符，并转换为小写
 * @param {String} key - 需要规范化的键名
 * @returns {String} 规范化后的键名
 */
function normalizeKey(key) {
    return key.replace(/[^a-zA-Z0-9.-]/g, '').toLowerCase();
}

/**
 * 规范化服务对象
 * 过滤掉不需要的字段（domains 和 aliases）
 * @param {Object} service - 原始服务对象
 * @returns {Object} 规范化后的服务对象
 */
function normalizeService(service) {
    let filter = ['domains', 'aliases']; // 需要过滤的字段
    let response = {};

    // 遍历服务对象的每个属性
    Object.keys(service).forEach(key => {
        if (filter.indexOf(key) < 0) response[key] = service[key]; // 只保留不在过滤列表中的属性
    });

    return response;
}

/**
 * 根据提供的键名解析 SMTP 配置
 * 键名可以是服务名称（如 'Gmail'）、别名（如 'Google Mail'）或邮箱地址（如 'test@googlemail.com'）
 * @param {String} key - 服务名称、别名或邮箱地址
 * @returns {Object|Boolean} SMTP 配置对象，如果未找到则返回 false
 */
module.exports = function (key) {
    // 如果是邮箱地址，提取域名部分并规范化
    key = normalizeKey(key.split('@').pop());
    // 返回对应的配置对象，未找到则返回 false
    return normalized[key] || false;
};