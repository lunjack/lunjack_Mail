constructor(options = {}, logger) {
    super();
    this.options = options;

    // 服务账户验证
    if (options?.serviceClient) {
        const { privateKey, user } = options;
        if (!privateKey || !user) {
            return setImmediate(() => this.emit('error',
                new Error('服务账户需要 "privateKey" 和 "user" 选项！')));
        }

        // 限制超时时间在 0-3600 秒之间，默认 5 分钟
        const timeout = Math.min(Math.max(Number(options.serviceRequestTimeout) || 0, 0), 3600);
        this.options.serviceRequestTimeout = timeout || 5 * 60;
    }

    this.logger = getLogger({ logger }, {
        component: options.component || 'OAuth2'
    });

    this.provisionCallback = typeof options.provisionCallback === 'function'
        ? options.provisionCallback
        : false;

    // 使用空值合并运算符设置默认值
    this.options = {
        accessUrl: 'https://accounts.google.com/o/oauth2/token',
        customHeaders: {},
        customParams: {},
        ...options
    };

    this.accessToken = options.accessToken ?? false;

    // 设置过期时间：优先使用 expires，其次使用 TTL，最后为 0
    const { expires, timeout } = options;
    const timeoutValue = Math.max(Number(timeout) || 0, 0);
    this.expires = (expires && Number(expires)) ? expires : (timeoutValue ? Date.now() + timeoutValue * 1000 : 0);

    this.renewing = false; // 跟踪是否正在续订
    this.renewalQueue = []; // 续订期间待处理请求的队列
}