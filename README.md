# lunjack-mail - 轻量级邮件发送库

一个简单易用的 Node.js 邮件发送库，支持多种邮件服务商，无需依赖外部邮件测试服务。

## 项目运行导图

```mermaid
graph TD
    A[开始使用] --> B[安装依赖]
    B --> C[配置邮件参数]
    C --> D[验证配置]
    D --> E{配置是否有效?}
    E -->|是| F[创建传输器]
    E -->|否| C
    F --> G[发送邮件]
    G --> H{发送结果}
    H -->|成功| I[显示成功信息]
    H -->|失败| J[显示错误信息]
    I --> K[结束]
    J --> K
```

## 安装

```bash
npm i lunjack-mail
```

## 优势

- **安全性**：不依赖外部服务，数据完全可控
- **真实性**：使用真实邮箱测试，结果更准确
- **灵活性**：支持各种邮件服务商（Gmail、Outlook、QQ邮箱等）
- **简单性**：安装时在项目根目录动态创建邮件示例,配置更直接，无需理解复杂的测试服务概念
- **配置验证**：发送前可验证配置,确保必要的配置项已填写
- **清晰的错误提示**：指导用户正确使用

## 快速开始

### 邮件配置及发送(标准配置示例)

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

### 常用邮箱配置示例(简写)

#### Gmail
```javascript
const transporter = mail.createTransport({
    service: 'Gmail',
    auth: {
        user: 'your-email@gmail.com',
        pass: 'your-app-password' // 需要启用两步验证并使用应用专用密码
    }
});
```

#### QQ邮箱
```javascript
const transporter = mail.createTransport({
     service: 'QQ',
    auth: {
        user: 'your-email@qq.com',
        pass: 'your-authorization-code' // QQ邮箱授权码，非登录密码
    }
});
```

#### 163邮箱
```javascript
const transporter = mail.createTransport({
    service: '163',
    auth: {
        user: 'your-email@163.com',
        pass: 'your-authorization-code' // 163邮箱授权码
    }
});
```

## 配置验证

在创建传输器前验证配置的有效性，避免运行时错误。

### 验证配置示例

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

## 高级用法

### 发送带附件的邮件

```javascript
transporter.sendMail({
    from: 'your-email@example.com',
    to: 'recipient@example.com',
    subject: '带附件的测试邮件',
    text: '这是一封带附件的测试邮件',
    html: '<b>这是一封带附件的测试邮件</b>',
    attachments: [
        {
            filename: 'document.pdf',
            path: './documents/document.pdf'
        },
        {
            filename: 'image.png',
            content: 'base64 encoded string', // 或使用 path 参数
            encoding: 'base64'
        }
    ]
}, (error, info) => {
    if (error) console.error('发送失败:', error);
    else console.log('发送成功:', info.response);
});
```

### 使用 Promise 语法

```javascript
// 使用 async/await
async function sendEmail() {
    try {
        const info = await transporter.sendMail({
            from: 'your-email@example.com',
            to: 'recipient@example.com',
            subject: '测试邮件',
            text: '这是一封测试邮件'
        });
        console.log('邮件发送成功:', info.messageId);
    } catch (error) {
        console.error('邮件发送失败:', error);
    }
}

sendEmail();
```
---
：#其它使用示例:
## 1. SMTP 连接池（高并发场景）

```javascript
const mail = require('lunjack-mail');

// 1. 创建连接池传输器
const transporter = mail.createTransport({
  pool: true, // 启用连接池
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: 'your-email@gmail.com',
    pass: 'your-app-password'
  },
  maxConnections: 5,    // 最大连接数
  maxMessages: 100,     // 每个连接最大邮件数
  rateDelta: 1000,      // 速率限制时间间隔
  rateLimit: 5          // 每秒最多发送5封
});

// 2. 发送多封邮件的示例
const emails = [
  { to: 'user1@example.com', name: '用户1' },
  { to: 'user2@example.com', name: '用户2' },
  { to: 'user3@example.com', name: '用户3' }
];

async function sendBulkEmails() {
  for (const email of emails) {
    const mailOptions = {
      from: '"系统通知" <noreply@example.com>',
      to: email.to,
      subject: `您好 ${email.name}`,
      html: `<p>亲爱的 ${email.name}，这是一封测试邮件</p>`
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`发送给 ${email.name} 成功:`, info.messageId);
    } catch (error) {
      console.log(`发送给 ${email.name} 失败:`, error);
    }
  }

  // 关闭连接池
  transporter.close();
}

sendBulkEmails();
```

## 2. Sendmail 传输（Linux/Unix 系统）

```javascript
const mail = require('lunjack-mail');

// 1. 创建Sendmail传输器
const transporter = mail.createTransport({
  sendmail: true,
  path: '/usr/sbin/sendmail' // 默认路径，通常不需要指定
});

// 2. 配置邮件内容
const mailOptions = {
  from: '"系统" <system@server.com>',
  to: 'admin@example.com',
  subject: '服务器报警',
  text: 'CPU使用率超过90%，请及时处理！',
  html: '<h1>服务器报警</h1><p>CPU使用率超过90%，请及时处理！</p>'
};

// 3. 发送邮件
transporter.sendMail(mailOptions, (error, info) => {
  if (error) {
    console.log('发送失败:', error);
  } else {
    console.log('发送成功!');
    console.log('响应:', info.response);
  }
});
```

## 3. 流传输（用于测试和开发）

```javascript
const mail = require('lunjack-mail');
const fs = require('fs');

// 1. 创建流传输器
const transporter = mail.createTransport({
  streamTransport: true,
  buffer: true,        // 将邮件内容缓冲到内存
  newline: 'unix'      // 使用Unix换行符
});

// 2. 配置邮件内容
const mailOptions = {
  from: '"测试" <test@example.com>',
  to: 'developer@example.com',
  subject: '测试邮件 - 不实际发送',
  text: '这封邮件不会实际发送，只会输出到控制台或文件',
  html: '<b>HTML内容</b>',
  attachments: [
    {
      filename: 'test.txt',
      content: '这是附件内容'
    }
  ]
};

// 3. 发送邮件（实际上只是生成邮件源码）
transporter.sendMail(mailOptions, (error, info) => {
  if (error) {
    console.log('生成邮件失败:', error);
  } else {
    console.log('邮件源码:');
    console.log(info.message.toString());

    // 可选：保存到文件
    fs.writeFileSync('debug-email.eml', info.message.toString());
    console.log('邮件已保存到 debug-email.eml');
  }
});
```

## 4. JSON 传输（用于调试）

```javascript
const mail = require('lunjack-mail');

// 1. 创建JSON传输器
const transporter = mail.createTransport({
  jsonTransport: true
});

// 2. 配置邮件内容
const mailOptions = {
  from: '"调试" <debug@example.com>',
  to: 'test@example.com, test2@example.com',
  subject: '调试邮件',
  text: '这封邮件会返回JSON格式的信息',
  html: '<b>调试内容</b>'
};

// 3. 发送邮件
transporter.sendMail(mailOptions, (error, info) => {
  if (error) {
    console.log('错误:', error);
  } else {
    console.log('邮件信息（JSON格式）:');
    console.log(JSON.stringify(info.message, null, 2));

    // info.message 包含：
    // - envelope: 信封信息（发件人、收件人）
    // - messageId: 邮件ID
    // - response: 响应信息
  }
});
```

## 5. SES 传输（AWS 亚马逊服务）

```javascript
const mail = require('lunjack-mail');
const { SESClient } = require('@aws-sdk/client-ses');

// 1. 配置 AWS SES
const sesClient = new SESClient({
  region: 'us-east-1', // 你的AWS区域
  credentials: {
    accessKeyId: '你的AccessKey',
    secretAccessKey: '你的SecretKey'
  }
});

// 2. 创建SES传输器
const transporter = mail.createTransport({
  SES: {
    ses: sesClient,
    aws: {}
  }
});

// 3. 配置邮件内容
const mailOptions = {
  from: '"AWS SES" <verified-email@yourdomain.com>', // 必须是验证过的邮箱
  to: 'recipient@example.com',
  subject: '来自AWS SES的测试邮件',
  text: '这封邮件通过Amazon SES发送',
  html: '<h1>AWS SES测试</h1><p>这封邮件通过Amazon SES发送</p>'
};

// 4. 发送邮件
async function sendWithSES() {
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('SES发送成功!');
    console.log('Message ID:', info.messageId);
    console.log('响应:', info.response);
  } catch (error) {
    console.log('SES发送失败:', error);
  }
}

sendWithSES();
```

## 6. 使用连接字符串的简便方式

```javascript
const mail = require('lunjack-mail');

// 1. 使用连接字符串创建传输器
const transporter = mail.createTransport(
  'smtps://username:password@smtp.gmail.com:465'
);

// 2. 配置邮件内容
const mailOptions = {
  from: '"测试" <user@gmail.com>',
  to: 'friend@example.com',
  subject: '连接字符串示例',
  text: '使用连接字符串配置SMTP'
};

// 3. 发送邮件
transporter.sendMail(mailOptions)
  .then(info => {
    console.log('发送成功:', info.messageId);
  })
  .catch(error => {
    console.log('发送失败:', error);
  });
```

每个示例都包含了：
1. **配置传输器** - 创建特定类型的邮件传输器
2. **设置邮件内容** - 定义发件人、收件人、主题、内容等
3. **发送邮件** - 执行发送操作并处理结果

对于生产环境，推荐使用 SMTP 或 SES；对于开发和测试，可以使用流传输或 JSON 传输;

---
## 错误处理

库提供了详细的错误信息，帮助您快速定位问题：

- **配置错误**：如缺少必要参数、无效的端口号等
- **连接错误**：如无法连接到SMTP服务器
- **认证错误**：如用户名或密码错误
- **发送错误**：如收件人地址无效、邮件被拒绝等

## 注意事项

1. 确保您的邮箱已开启SMTP服务
2. 部分邮箱服务商需要使用授权码而非登录密码
3. 建议在生产环境中使用环境变量存储敏感信息
4. 发送频率过高可能被邮箱服务商限制

## 许可证

ISC