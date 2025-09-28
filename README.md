## 优势
- **安全性**：不依赖外部服务，数据完全可控
- **真实性**：使用真实邮箱测试，结果更准确
- **灵活性**：支持各种邮件服务商（Gmail、Outlook、QQ邮箱等）
- **简单性**：安装时在项目根目录动态创建邮件示例,配置更直接，无需理解复杂的测试服务概念
- **配置验证**：发送前可验证配置,确保必要的配置项已填写
- **清晰的错误提示**：指导用户正确使用

## 使用示例

```javascript
const mail = require('lunjack-mail');
// 邮箱配置示例 - 请根据您的邮箱服务商修改以下配置
const transporter = mail.createTransport({

    // 邮箱服务商SMTP服务器地址(Gmail: 'smtp.gmail.com'; QQ: 'smtp.qq.com'; 163: 'smtp.163.com')
    host: 'smtp.your-email-provider.com',

    // 端口号，通常为 465(SSL) 或 587(TLS)
    port: 587,

    // 是否使用SSL/TLS
    secure: false, // true for 465, false for other ports

    auth: {
        user: 'your-email@example.com', // 您的邮箱地址

        // 您的邮箱密码或授权码(Gmail需要应用专用密码，QQ邮箱需要授权码)
        pass: 'your-password-or-app-password'
    }
});

// 发送邮件示例
transporter.sendMail({
    from: 'your-email@example.com', // 发件人
    to: 'recipient@example.com',    // 收件人
    subject: '测试邮件',             // 邮件主题
    text: '这是一封测试邮件(text)',         // 纯文本内容
    html: '<b>这是一封测试邮件(html)</b>'   // HTML内容（可选;注:html内容优先级高于纯文本内容)
}, (error, info) => {
    if (error)  console.error('发送失败:', error);
    else console.log('发送成功:', info.response);
});
```

## 验证配置示例

```javascript
const mail = require('lunjack-mail');

// 1. 验证URL格式配置
const urlConfig = 'smtps://user:pass@smtp.your-email-provider.com:465';
const validation1 = mail.validateConfig(urlConfig);
if (!validation1.valid) {
    console.error('配置错误:', validation1.errors);
} else if (validation1.warnings) {
    console.warn('配置警告:', validation1.warnings);
}

// 2. 验证对象配置
const objectConfig = {
    host: 'smtp.your-email-provider.com',
    port: 587,
    secure: false,
    auth: {
        user: 'your-email@example.com',
        pass: 'password'
    }
};
const validation2 = mail.validateConfig(objectConfig);
if (validation2.valid) {
    const transporter = mail.createTransport(objectConfig);
    console.log('传输器创建成功');
} else {
    console.error('配置无效，无法创建传输器:', validation2.errors);
}

// 3. 验证无效配置
const invalidConfig = {
   host: 'smtp.your-email-provider.com',
    port: 70000, // 无效端口
    auth: {
        user: 'your-email@example.com'
        // 缺少密码
    }
};
const validation3 = mail.validateConfig(invalidConfig);
console.log('无效配置验证结果:', validation3);
```