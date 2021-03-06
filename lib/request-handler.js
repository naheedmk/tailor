'use strict';
const AsyncStream = require('./streams/async-stream');
const Fragment = require('./fragment');
const StringifierStream = require('./streams/stringifier-stream');
const ContentLengthStream = require('./streams/content-length-stream');
const FRAGMENT_EVENTS = ['start', 'response', 'end', 'error', 'timeout', 'fallback', 'warn'];

module.exports = function processRequest (options, request, response) {

    this.emit('start', request);

    const fetchContext = options.fetchContext;
    const fetchTemplate = options.fetchTemplate;
    const handleTag = options.handleTag;
    const parseTemplate = options.parseTemplate;
    const requestFragment = options.requestFragment;
    const pipeInstanceName = options.pipeInstanceName();
    const pipeDefinition = options.pipeDefinition(pipeInstanceName);

    const asyncStream = new AsyncStream();
    const contextPromise = fetchContext(request).catch((err) => {
        this.emit('context:error', request, err);
        return {};
    });
    const templatePromise = fetchTemplate(request, parseTemplate);
    const responseHeaders = {
        // Disable cache in browsers and proxies
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Content-Type': 'text/html'
    };

    let shouldWriteHead = true;
    let index = 0;

    contextPromise.then((context) => {

        const contentLengthStream = new ContentLengthStream((contentLength) => {
            this.emit('end', request, contentLength);
        });

        const resultStream = new StringifierStream((tag) => {

            if (tag.placeholder === 'pipe') {
                return pipeDefinition;
            }

            if (tag.placeholder === 'async') {
                // end of body tag
                return asyncStream;
            }

            if (tag.name === options.fragmentTag) {
                const fragment = new Fragment(
                    tag,
                    context,
                    index++,
                    requestFragment,
                    pipeInstanceName
                );

                FRAGMENT_EVENTS.forEach((eventName) => {
                    fragment.on(eventName, (function () {
                        // this has to be a function, because
                        // arrow functions don't have `arguments`
                        const prefixedName = 'fragment:' + eventName;
                        const prefixedArgs = [prefixedName, request, fragment.attributes].concat(...arguments);
                        this.emit.apply(this, prefixedArgs);
                    }).bind(this));
                });

                if (fragment.attributes.async) {
                    asyncStream.write(fragment.stream);
                }

                if (fragment.attributes.primary && shouldWriteHead) {
                    shouldWriteHead = false;
                    fragment.on('response', (statusCode, headers) => {
                        if (headers.location) {
                            responseHeaders['Location'] = headers.location;
                        }
                        this.emit('response', request, statusCode, responseHeaders);
                        response.writeHead(statusCode, responseHeaders);
                        resultStream
                            .pipe(contentLengthStream)
                            .pipe(response);
                    });
                    fragment.on('fallback', (err) => {
                        this.emit('error', request, err);
                        response.writeHead(500, responseHeaders);
                        resultStream
                            .pipe(contentLengthStream)
                            .pipe(response);
                    });
                    fragment.on('error', (err) => {
                        this.emit('error', request, err);
                        response.writeHead(500, responseHeaders);
                        response.end();
                    });
                }

                return fragment.fetch(request, false);
            }

            return handleTag(request, tag);
        });


        resultStream.on('finish', () => {
            asyncStream.end();
            const statusCode = response.statusCode || 200;
            if (shouldWriteHead) {
                shouldWriteHead = false;
                this.emit('response', request, statusCode, responseHeaders);
                response.writeHead(statusCode, responseHeaders);
                resultStream
                    .pipe(contentLengthStream)
                    .pipe(response);
            }
        });

        resultStream.on('error', (err) => {
            this.emit('error', request, err);
            if (shouldWriteHead) {
                shouldWriteHead = false;
                response.writeHead(500, responseHeaders);
                // To render with custom error template
                if (typeof err.presentable === 'string') {
                    response.end(`${err.presentable}`);
                } else {
                    response.end();
                }
            } else {
                contentLengthStream.end();
            }
        });

        templatePromise
            .then((template) => {
                resultStream.end(template);
            })
            .catch((err) => {
                resultStream.emit('error', err);
            });
    });
};
