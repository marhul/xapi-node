import {TransactionResolveSocket} from "../../interface/Interface";
import XAPI from "../XAPI";
import {Time} from "../../modules/Time";
import {WebSocketWrapper} from "../../modules/WebSocketWrapper";
import Logger from "../../utils/Logger";
import {errorCode} from "../../enum/errorCode";
import {TransactionStatus, TransactionType} from "../../enum/Enum";
import {Queue} from "../Queue";

export class SocketConnection extends Queue {

	protected XAPI: XAPI;

	public status: boolean = false;
	private openTimeout: NodeJS.Timeout | null = null;
	private _password: string;

	constructor(XAPI: XAPI, password: string) {
		super(XAPI.rateLimit, TransactionType.SOCKET);
		this._password = password;
		this.XAPI = XAPI;
	}

	private getInfo(customTag: string | null): { transactionId: string | null, command: string | null } {
		if (customTag == null) {
			return { transactionId: null, command: null };
		}
		const customTagData = customTag.split('_');
		if (customTagData.length < 2) {
			return { transactionId: null, command: null };
		}
		const command = customTagData[0];
		const transactionId = customTagData[1];

		if (this.transactions[transactionId] === undefined) {
			return { transactionId: null, command };
		}
		return { transactionId, command };
	}

	private handleData(returnData: any, customTag: string, time: Time) {
		const { transactionId, command } = this.getInfo(customTag);

		if (transactionId !== null && command !== null) {
			this.transactions[transactionId].response = {
				status: true,
				received: time,
				json: returnData
			};

			this.resolveTransaction(returnData, time, this.transactions[transactionId]);

			if (this.listeners[command] !== undefined) {
				this.callListener(command, [returnData, time, this.transactions[transactionId]]);
			}
		} else {
			Logger.log.error('Received a message without vaild customTag (customTag = ' + customTag + ')\n' + JSON.stringify(returnData, null, "\t"));
		}
	}

	public connect() {
		if (this.XAPI.tryReconnect === false) {
			Logger.log.hidden("Socket connect is called when tryReconnect is false", "WARN");
			return;
		}
		this.WebSocket = new WebSocketWrapper('wss://' + this.XAPI.hostName +'/' + this.XAPI.accountType);
		this.WebSocket.onOpen(() => {
			Logger.log.hidden("Socket open", "INFO");
			this.resetMessageTube();
			this.setConnection(true);
		});

		this.WebSocket.onClose(() => {
			if (this.status === true) {
				Logger.log.hidden("Socket closed", "INFO");
			}
			this.setConnection(false);
			this.resetMessageTube();
			if (this.XAPI.tryReconnect) {
				setTimeout(() => {
					if (this.XAPI.tryReconnect) {
						this.connect();
					}
				}, 2000);
			}
			for (const transactionId in this.transactions) {
				const isInterrupted = (this.transactions[transactionId].status === TransactionStatus.sent);
				if (this.transactions[transactionId].status === TransactionStatus.waiting || isInterrupted) {
					this.rejectTransaction({ code: errorCode.XAPINODE_1, explain: "Socket closed"}, this.transactions[transactionId], isInterrupted);
				}
			}
		});

		this.WebSocket.onMessage((message: any) => {
			try {
				this.handleSocketMessage(JSON.parse(message.toString().trim()), new Time());
			} catch (e) {
				const { name, message, stack } = new Error(e);
				Logger.log.error("Socket websocket error");
				Logger.log.hidden(name + "\n" + message, "ERROR");
				if (stack) {
					Logger.log.hidden(stack, "ERROR");
				}
				Logger.log.hidden("Message: " + message.toString(), "ERROR");
			}
		});

		this.WebSocket.onError((error: any) => {
			Logger.log.error("Socket: WebSocket ERROR");
			Logger.log.error(error);
		});

	}

	public onConnectionChange(callBack: (status: boolean) => void, key: string | null = null) {
		this.addListener("connectionChange", callBack, key);
	}

	private setConnection(status: boolean) {
		if (this.status !== status) {
			this.status = status;
			this.callListener("connectionChange", [status]);
		} else {
			this.status = status;
		}

		if (this.openTimeout !== null) {
			clearTimeout(this.openTimeout);
		}
		if (status) {
			this.ping();
			this.openTimeout = setTimeout(() => {
				this.openTimeout = null;
				if (this.status) {
					this.tryLogin(2);
				}
			}, 1000);
		}
	}

	private tryLogin(retries: number = 2) {
		this.XAPI.Socket.login().then(() => {
			Logger.log.hidden("Login is successful (userId = " + this.XAPI.accountId
				+ ", accountType = " + this.XAPI.accountType + ")", "INFO");
			this.ping();
		}).catch(e => {
			Logger.log.hidden("Login is rejected (userId = " + this.XAPI.accountId
				+ ", accountType = " + this.XAPI.accountType
				+ ")\nReason:\n" + JSON.stringify(e, null, "\t"), "ERROR");
			if (retries > 0 && e.reason.code !== errorCode.XAPINODE_1 && e.reason.code !== errorCode.BE005) {
				setTimeout(() => {
					Logger.log.hidden("Try to login (retries = " + retries + ")", "INFO");
					this.tryLogin(retries - 1);
				}, 500);
			} else if (e.reason.code === errorCode.BE005) {
				Logger.log.error("Disconnect from stream and socket (reason = 'login error code is " + e.reason.code + "')");
				this.XAPI.disconnect();
			}
		});
	}

	private handleError(code: any, explain: any, customTag: string | null, received: Time) {
		const { transactionId } = this.getInfo(customTag);

		if (transactionId !== null) {
			this.rejectTransaction({ code, explain }, this.transactions[transactionId], false, received);
		} else {
			Logger.log.hidden("Socket error message:\n"
				+ JSON.stringify({ code, explain, customTag }, null, "\t"), "ERROR");
		}
	}

	private handleSocketMessage(message: any, time: Time) {
		this.lastReceivedMessage.reset();
		if (message.status) {
			this.handleData(
				(message.streamSessionId !== undefined) ?
						{streamSessionId: message.streamSessionId} : message.returnData,
				typeof(message.customTag) === 'string' ?
						message.customTag : null,
				time);
		} else if (message.status !== undefined
			&& message.errorCode !== undefined) {
			const { errorCode } = message;
			const customTag: string | null = message.customTag !== undefined ? message.customTag : null;
			const errorDescr: string | null  = message.errorDescr !== undefined ? message.errorDescr : null;
			this.handleError(errorCode, errorDescr, customTag, time);
		}
	}

	protected sendCommand<T>(command: string, args: any = {}, transactionId: string | null = null, urgent: boolean = false):
		Promise<TransactionResolveSocket<T>> {
		return new Promise((resolve: any, reject: any) => {
			if (transactionId === null) {
				transactionId = this.createTransactionId();
			}
			const json = JSON.stringify({
				command,
				arguments: (Object.keys(args).length === 0) ? undefined : args,
				customTag: command + '_' + transactionId });
			const transaction = this.addTransaction({
				command, json, args, transactionId, urgent, resolve, reject
			});
			if (this.status === false) {
				this.rejectTransaction({
					code: errorCode.XAPINODE_1,
					explain: "Socket closed"
				}, this.transactions[transactionId]);
			} else if (this.XAPI.Stream.session.length === 0
				&& "login" !== command
				&& "ping" !== command
				&& "logout" !== command) {
				this.rejectTransaction({ code: errorCode.XAPINODE_BE103, explain: 'User is not logged' }, transaction);
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
