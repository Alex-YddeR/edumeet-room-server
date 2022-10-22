import EventEmitter from 'events';
import { Logger } from './common/logger';
import jwt from 'jsonwebtoken';
import { BaseConnection, InboundRequest } from './signaling/BaseConnection';
import { SocketMessage } from './signaling/SignalingInterface';
import { signingkey } from './common/token';
import { Pipeline } from './common/middleware';
import { userRoles } from './common/authorization';
import { Router } from 'mediasoup/node/lib/Router';
import { WebRtcTransport } from 'mediasoup/node/lib/WebRtcTransport';
import { Consumer } from 'mediasoup/node/lib/Consumer';
import { Producer } from 'mediasoup/node/lib/Producer';
import { Role } from './common/types';
import { skipIfClosed } from './common/decorators';
import { RtpCapabilities } from 'mediasoup/node/lib/RtpParameters';
import { RouterData } from './MediaService';

const logger = new Logger('Peer');

interface PeerOptions {
	id: string;
	displayName?: string;
	picture?: string;
	roomId: string;
	connection?: BaseConnection;
	token?: string;
}

export interface PeerInfo {
	id: string;
	displayName?: string;
	picture?: string;
	roles: number[];
	raisedHand: boolean;
	raisedHandTimestamp?: number;
}

export interface PeerContext {
	peer: Peer;
	message: SocketMessage;
	response: Record<string, unknown>;
	handled: boolean;
}

/* eslint-disable no-unused-vars */
export declare interface Peer {
	on(event: 'close', listener: () => void): this;
	on(event: 'notification', listener: (notification: SocketMessage) => void): this;
	on(event: 'request', listener: InboundRequest): this;

	on(event: 'gotRole', listener: (newRole: Role) => void): this;
	on(event: 'lostRole', listener: (oldRole: Role) => void): this;
}
/* eslint-enable no-unused-vars */

export class Peer extends EventEmitter {
	public id: string;
	public closed = false;
	public roles: Role[] = [ userRoles.NORMAL ];
	public connections: BaseConnection[] = [];
	public displayName: string;
	public picture?: string;
	#raisedHand = false;
	public raisedHandTimestamp?: number;
	public routerId?: string;
	public rtpCapabilities?: RtpCapabilities;
	#router?: Router;
	public transports = new Map<string, WebRtcTransport>();
	public consumers = new Map<string, Consumer>();
	public producers = new Map<string, Producer>();
	public roomId: string;
	public pipeline = Pipeline<PeerContext>();
	private token: string;

	constructor({
		id,
		token,
		displayName,
		picture,
		roomId,
		connection,
	}: PeerOptions) {
		logger.debug('constructor() [id: %s]', id);

		super();

		this.id = id;
		this.roomId = roomId;
		this.displayName = displayName ?? 'Guest';
		this.picture = picture;
		this.token = token ?? this.assignToken();

		if (connection)
			this.addConnection(connection);
	}

	@skipIfClosed
	public close(): void {
		logger.debug('close() [peerId: %s]', this.id);

		this.closed = true;

		this.connections.forEach((c) => c.close());
		this.producers.forEach((p) => p.close());
		this.consumers.forEach((c) => c.close());
		this.transports.forEach((t) => t.close());

		if (this.router) {
			const { peers } = this.router.appData.serverData as RouterData;

			peers.delete(this.id);
		}

		this.connections = [];
		this.producers.clear();
		this.consumers.clear();
		this.transports.clear();

		this.emit('close');
	}

	public get raisedHand(): boolean {
		return this.#raisedHand;
	}

	public set raisedHand(value: boolean) {
		this.#raisedHand = value;
		this.raisedHandTimestamp = Date.now();
	}

	public get router(): Router | undefined {
		return this.#router;
	}

	public set router(router: Router | undefined) {
		if (!router) return;

		const { peers } = router.appData.serverData as RouterData;

		this.#router = router;
		peers.set(this.id, this);
	}

	@skipIfClosed
	public addRole(newRole: Role): void {
		const index = this.roles.findIndex((r) => r.id === newRole.id);

		if (index === -1 && newRole.id !== userRoles.NORMAL.id) {
			this.roles.push(newRole);
			this.emit('gotRole', { newRole });
		}
	}

	@skipIfClosed
	public removeRole(oldRole: Role): void {
		const index = this.roles.findIndex((r) => r.id === oldRole.id);

		if (index !== -1 && oldRole.id !== userRoles.NORMAL.id) {
			this.roles.splice(index, 1);
			this.emit('lostRole', { oldRole });
		}
	}

	@skipIfClosed
	private addConnection(connection: BaseConnection): void {
		logger.debug('addConnection()');

		this.connections.push(connection);
		this.connections.sort((a, b) => {
			if (a.priority > b.priority) return 1;
			if (a.priority < b.priority) return -1;

			return 0;
		});

		connection.on('notification', async (notification) => {
			try {
				const context = {
					peer: this,
					message: notification,
					response: {},
					handled: false,
				} as PeerContext;

				await this.pipeline.execute(context);

				if (!context.handled)
					throw new Error('no middleware handled the notification');
			} catch (error) {
				logger.error('notification() [error: %o]', error);
			}
		});

		connection.on('request', async (request, respond, reject) => {
			try {
				const context = {
					peer: this,
					message: request,
					response: {},
					handled: false,
				} as PeerContext;

				await this.pipeline.execute(context);

				if (context.handled)
					respond(context.response);
				else {
					logger.debug('request() unhandled request [method: %s]', request.method);

					reject('Server error');
				}
			} catch (error) {
				logger.error('request() [error: %o]', error);

				reject('Server error');
			}
		});

		connection.once('close', () => {
			this.connections = this.connections.filter((c) => c.id !== connection.id);

			if (this.connections.length === 0)
				this.close();
		});

		connection.notify({
			method: 'token',
			data: { token: this.token }
		});
	}

	@skipIfClosed
	public async notify(notification: SocketMessage): Promise<void> {
		logger.debug('notify() [peerId: %s, method: %s]', this.id, notification.method);

		for (const connection of this.connections) {
			try {
				return await connection.notify(notification);
			} catch (error) {
				logger.error('notify() [error: %o]', error);
			}
		}

		logger.warn('notify() no connection available [peerId: %s]', this.id);
	}

	@skipIfClosed
	public async request(request: SocketMessage): Promise<unknown> {
		logger.debug('request() [peerId: %s, method: %s]', this.id, request.method);

		for (const connection of this.connections) {
			try {
				return await connection.request(request);
			} catch (error) {
				logger.error('request() [error: %o]', error);
			}
		}

		logger.warn('request() no connection available [peerId: %s]', this.id);
	}

	private assignToken(): string {
		return jwt.sign({ id: this.id }, signingkey, { noTimestamp: true });
	}

	public get peerInfo(): PeerInfo {
		return {
			id: this.id,
			displayName: this.displayName,
			picture: this.picture,
			raisedHand: this.raisedHand,
			raisedHandTimestamp: this.raisedHandTimestamp,
			roles: this.roles.map((role) => role.id),
		};
	}
}