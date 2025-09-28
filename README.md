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

// 邮箱配置
const transporter = mail.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: 'your-email@gmail.com',
        pass: 'your-app-password'
    }
});

// 发送测试邮件
transporter.sendMail({
    from: 'your-email@gmail.com',
    to: 'test@example.com',
    subject: '测试邮件',
    text: '这是一封测试邮件'
}, (error, info) => {
    if (error) {
        console.error('发送失败:', error);
    } else {
        console.log('发送成功:', info.response);
    }
});
```

## 验证配置示例

```javascript
const mail = require('lunjack-mail');

// 1. 验证URL格式配置
const urlConfig = 'smtps://user:pass@smtp.gmail.com:465';
const validation1 = mail.validateConfig(urlConfig);
if (!validation1.valid) {
    console.error('配置错误:', validation1.errors);
} else if (validation1.warnings) {
    console.warn('配置警告:', validation1.warnings);
}

// 2. 验证对象配置
const objectConfig = {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: 'test@gmail.com',
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
    host: 'smtp.gmail.com',
    port: 70000, // 无效端口
    auth: {
        user: 'test@gmail.com'
        // 缺少密码
    }
};
const validation3 = mail.validateConfig(invalidConfig);
console.log('无效配置验证结果:', validation3);
```