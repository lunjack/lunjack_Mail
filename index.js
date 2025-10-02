'use strict';
/**
 * Nodemailer 主模块
 *
 * 模块依赖说明：
 * - Mailer: 核心邮件发送器，负责管理传输器和邮件发送流程
 * - shared: 共享工具函数模块，包含URL解析等通用功能
 * - SmtpPool: SMTP连接池传输器，支持连接复用和并发发送
 * - SMTPTransport: 标准SMTP传输器，用于通过SMTP服务器发送邮件
 * - SendmailTransport: 本地sendmail传输器，使用系统sendmail命令发送
 * - StreamTransport: 流传输器，将邮件输出为流格式，主要用于测试
 * - JSONTransport: JSON传输器，将邮件转换为JSON格式输出，用于调试
 * - SESTransport: Amazon SES传输器，通过AWS Simple Email Service发送邮件
 */
const Mailer = require('./lib/mailer');
const shared = require('./lib/shared');
const SmtpPool = require('./lib/smtp-pool');
const SMTPTransport = require('./lib/smtp-transport');
const SendmailTransport = require('./lib/sendmail-transport');
const StreamTransport = require('./lib/stream-transport');
const JSONTransport = require('./lib/json-transport');
const SESTransport = require('./lib/ses-transport');

module.exports.createTransport = function (transporter, defaults) {
    let urlConfig;
    let options;
    let mailer;

    // 如果传入的transporter是配置对象而非传输器插件,或者看起来像是连接URL
    if ((typeof transporter === 'object' && typeof transporter.send !== 'function') ||
        (typeof transporter === 'string' && /^(smtps?|direct):/i.test(transporter))) {
        // 将配置URL解析为配置选项
        if ((urlConfig = typeof transporter === 'string' ? transporter : transporter.url))
            options = shared.parseConnectionUrl(urlConfig);
        else options = transporter;

        if (options.pool) transporter = new SmtpPool(options);
        else if (options.sendmail) transporter = new SendmailTransport(options);
        else if (options.streamTransport) transporter = new StreamTransport(options);
        else if (options.jsonTransport) transporter = new JSONTransport(options);
        else if (options.SES) {
            if (options.SES.ses && options.SES.aws) {
                let error = new Error('检测到旧版SES配置，请使用@aws-sdk/client-sesv2，');
                error.code = 'LegacyConfig';
                throw error;
            }
            transporter = new SESTransport(options);
        } else transporter = new SMTPTransport(options);
    }

    mailer = new Mailer(transporter, options, defaults);
    return mailer;
};

// 验证配置
module.exports.validateConfig = function (config) {
    const errors = [];
    const warnings = [];

    // 检查配置类型
    if (!config) {
        errors.push('配置不能为空');
        return { valid: false, errors, warnings };
    }

    // 如果是字符串（URL格式）
    if (typeof config === 'string') {
        if (!/^(smtps?|direct):/i.test(config)) errors.push('URL格式不正确，应以 smtp://, smtps:// 或 direct:// 开头');
    }
    // 如果是配置对象
    else if (typeof config === 'object') {
        // 检查传输器类型
        const transportTypes = ['SMTP', 'Sendmail', 'Stream', 'JSON', 'SES'];
        const hasTransportType = transportTypes.some(type =>
            config[type.toLowerCase()] || config[type] || config[`${type}Transport`]
        );

        if (!hasTransportType && typeof config.send !== 'function') {
            // 默认为SMTP传输器，验证SMTP相关配置
            if (!config.host && !config.service) errors.push('必须指定 host 或 service');

            if (config.auth) {
                if (!config.auth.user) errors.push('认证配置中缺少 user 字段');
                if (!config.auth.pass && !config.auth.oauth2 && !config.auth.xoauth2)
                    warnings.push('认证配置中缺少 pass 字段，将尝试无密码连接');
            }
            // 非25端口通常需要认证
            else if (config.port !== 25) warnings.push('未提供认证信息，某些邮件服务器可能拒绝连接');

            if (config.port && (config.port < 1 || config.port > 65535)) errors.push('端口号应在 1-65535 范围内');

            // 检查TLS/SSL配置
            if (config.secure !== undefined && typeof config.secure !== 'boolean') errors.push('secure 字段应为布尔值');

            if (config.tls !== undefined && typeof config.tls !== 'object' && typeof config.tls !== 'boolean')
                errors.push('tls 字段应为对象或布尔值');
        }

        // 验证池配置
        if (config.pool && typeof config.pool !== 'boolean') errors.push('pool 字段应为布尔值');

        if (config.maxConnections && (typeof config.maxConnections !== 'number' || config.maxConnections < 1))
            errors.push('maxConnections 应为大于0的数字');

        if (config.maxMessages && (typeof config.maxMessages !== 'number' || config.maxMessages < 1))
            errors.push('maxMessages 应为大于0的数字');

        // 验证Sendmail配置
        if (config.sendmail) {
            if (config.sendmail !== true && typeof config.sendmail !== 'string') errors.push('sendmail 字段应为布尔值或字符串路径');
        }

        // 验证SES配置
        if (config.SES) {
            if (typeof config.SES !== 'object') errors.push('SES 配置应为对象');

            else if (config.SES.ses && config.SES.aws) warnings.push('检测到旧版SES配置，建议使用新版AWS SDK');
        }
    }
    else errors.push('配置应为字符串或对象');

    return {
        valid: errors.length === 0,
        errors,
        warnings: warnings.length > 0 ? warnings : undefined
    };
};