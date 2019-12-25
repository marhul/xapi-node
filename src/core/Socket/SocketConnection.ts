import {TransactionResolveSocket} from '../../interface/Interface';
import XAPI from '../XAPI';
import {Time} from '../..';
import {WebSocketWrapper} from '../../modules/WebSocketWrapper';
import {Log} from '../../utils/Log';
import {ConnectionStatus, errorCode, Listeners, TransactionStatus, TransactionType} from '../../enum/Enum';
import {Queue} from '../Queue';
import Utils from '../../utils/Utils';
import {Timer} from "../../modules/Timer";

export class SocketConnection extends Queue {
    private XAPI: XAPI;
    private _password: string;
    private loginTimeout: Timer = new Timer();

    constructor(XAPI: XAPI, password: string) {
        super(XAPI.rateLimit, TransactionType.SOCKET);
        this._password = password;
        this.XAPI = XAPI;
    }

    public connect() {
        this.WebSocket = new WebSocketWrapper('wss://' + this.XAPI.hostName + '/' + this.XAPI.accountType);
        this.WebSocket.onOpen(() => {
            this.setConnectionStatus(ConnectionStatus.CONNECTING);
        });

        this.WebSocket.onClose(() => {
            this.setConnectionStatus(ConnectionStatus.DISCONNECTED);
        });

        this.WebSocket.onMessage((message: any) => {
            try {
                const json = JSON.parse(message.toString().trim());
                this.lastReceivedMessage = new Time();
                this.handleSocketMessage(json, new Time());
            } catch (e) {
                const {name, message, stack} = new Error(e);
                Log.error('Socket Handle WebSocket Message Error');
                Log.hidden(name + '\n' + message + (stack ? '\n' + stack : ''), 'ERROR');
            }
        });

        this.WebSocket.onError((error: any) => {
            const {name, message, stack} = new Error(error);
            Log.error('Socket WebSocket Error');
            Log.hidden(name + '\n' + message + (stack ? '\n' + stack : ''), 'ERROR');
        });
    }

    public onConnectionChange(callBack: (status: ConnectionStatus) => void, key: string | null = null) {
        this.addListener(Listeners.xapi_onConnectionChange, callBack, key);
    }

    private setConnectionStatus(status: ConnectionStatus) {
        this.resetMessageTube();

        if (this.status !== status) {
            this.status = status;
            this.callListener(Listeners.xapi_onConnectionChange, [status]);
        }

        this.loginTimeout.clear();
        this.openTimeout.clear();
        this.reconnectTimeout.clear();

        if (status === ConnectionStatus.CONNECTING) {
            this.ping().catch(e => {
                Log.error('Socket: ping request failed');
            });
            this.openTimeout.setTimeout(() => {
                if (this.status === ConnectionStatus.CONNECTING) {
                    this.status = ConnectionStatus.CONNECTED;
                    this.callListener(Listeners.xapi_onConnectionChange, [ConnectionStatus.CONNECTED]);
                    this.tryLogin(2);
                }
            }, 1000);
        } else {
            if (this.XAPI.tryReconnect) {
                this.reconnectTimeout.setTimeout(() => {
                    if (this.status === ConnectionStatus.DISCONNECTED) {
                        this.connect();
                    }
                }, 2000);
            }

            for (const transactionId in this.transactions) {
                const isInterrupted = (this.transactions[transactionId].status === TransactionStatus.sent);
                if (this.transactions[transactionId].status === TransactionStatus.waiting || isInterrupted) {
                    this.rejectTransaction({
                        code: errorCode.XAPINODE_1,
                        explain: 'Socket closed'
                    }, this.transactions[transactionId], isInterrupted);
                }
            }
        }
    }

    private tryLogin(retries: number = 2) {
        this.login().catch(e => {
            Log.hidden('Login is rejected (userId = ' + this.XAPI.accountId
                + ', accountType = ' + this.XAPI.accountType
                + ')\nReason:\n' + JSON.stringify(e, null, '\t'), 'ERROR');
            if (retries > 0 && e.reason.code !== errorCode.XAPINODE_1 && e.reason.code !== errorCode.BE005) {
                this.loginTimeout.setTimeout(() => {
                    Log.hidden('Try to login (retries = ' + retries + ')', 'INFO');
                    this.tryLogin(retries - 1);
                }, 500);
            } else if (e.reason.code === errorCode.BE005) {
                Log.error('Disconnect from stream and socket (reason = \'login error code is ' + e.reason.code + '\')');
                this.XAPI.disconnect();
            }
            this.XAPI.callListener(Listeners.xapi_onReject, [e])
        });
    }

    private handleError(code: any, explain: any, customTag: string | null, received: Time) {
        const {transactionId} = Utils.parseCustomTag(customTag);

        if (transactionId !== null && this.transactions[transactionId] !== undefined) {
            this.rejectTransaction({code, explain}, this.transactions[transactionId], false, received);
        } else {
            Log.hidden('Socket error message:\n'
                + JSON.stringify({code, explain, customTag}, null, '\t'), 'ERROR');
        }
    }

    private handleSocketMessage(message: any, time: Time) {
        if (message.status) {
            const returnData = message.streamSessionId === undefined
                ? message.returnData
                : {streamSessionId: message.streamSessionId};
            const customTag = typeof (message.customTag) === 'string'
                ? message.customTag
                : null;
            const {transactionId, command} = Utils.parseCustomTag(customTag);

            if (transactionId !== null && command !== null && this.transactions[transactionId] !== undefined) {
                this.resolveTransaction(returnData, time, this.transactions[transactionId]);
                this.callListener('command_' + command, [returnData, time, this.transactions[transactionId]]);
            } else {
                Log.error('Received a message without vaild customTag (customTag = ' + customTag + ')\n'
                    + JSON.stringify(returnData, null, '\t'));
            }
        } else if (message.status !== undefined && message.errorCode !== undefined) {
            const {errorCode} = message;
            const customTag: string | null = message.customTag === undefined ? null : message.customTag;
            const errorDescr: string | null = message.errorDescr === undefined ? null : message.errorDescr;
            this.handleError(errorCode, errorDescr, customTag, time);
        }
    }

    protected sendCommand<T>(command: string, args: any = {}, transactionId: string | null = null, urgent: boolean = false):
        Promise<TransactionResolveSocket<T>> {
        return new Promise((resolve: any, reject: any) => {
            if (transactionId === null) {
                transactionId = this.createTransactionId();
            }
            const transaction = this.addTransaction({
                command,
                json: JSON.stringify({
                    command,
                    arguments: (Object.keys(args).length === 0) ? undefined : args,
                    customTag: command + '_' + transactionId
                }),
                args,
                transactionId,
                urgent,
                resolve,
                reject
            });
            if (transaction.request.json.length > 1000) {
                this.rejectTransaction({
                    code: errorCode.XAPINODE_0,
                    explain: 'Each command invocation should not contain more than 1kB of data.'
                }, transaction);
            } else if (this.status === ConnectionStatus.DISCONNECTED) {
                this.rejectTransaction({
                    code: errorCode.XAPINODE_1,
                    explain: 'Socket closed'
                }, this.transactions[transactionId]);
            } else if (this.XAPI.Stream.session.length === 0
                && 'login' !== command
                && 'ping' !== command
                && 'logout' !== command) {
                this.rejectTransaction({code: errorCode.XAPINODE_BE103, explain: 'User is not logged'}, transaction);
            } else if (this.XAPI.isTradingDisabled && command === 'tradeTransaction') {
                this.rejectTransaction({
                    code: errorCode.XAPINODE_4,
                    explain: 'Trading disabled in login config (safe = true)'
                }, this.transactions[transactionId]);
            } else {
                this.sendJSON(transaction, true);
            }
        });
    }

    public closeConnection() {
        if (this.WebSocket !== null) {
            this.WebSocket.close();
        }
    }

    public ping() {
        return this.sendCommand<null>('ping', {}, null, true);
    }

    public logout() {
        return this.sendCommand<null>('logout', {}, null, true);
    }

    public login() {
        return this.sendCommand('login', {
            'userId': this.XAPI.accountId,
            'password': this._password,
            'appName': this.XAPI.appName
        }, null, true);
    }
}
