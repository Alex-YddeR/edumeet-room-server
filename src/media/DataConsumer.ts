import { EventEmitter } from 'events';
import { MediaNodeConnection } from './MediaNodeConnection';
import { Router } from './Router';
import { Logger, skipIfClosed } from 'edumeet-common';
import { SctpStreamParameters } from 'mediasoup-client/lib/SctpParameters';

const logger = new Logger('DataConsumer');

export interface DataConsumerOptions {
	id: string;
	sctpStreamParameters: SctpStreamParameters;
	label?: string;
	protocol?: string;
}

interface InternalDataConsumerOptions extends DataConsumerOptions {
	router: Router;
	connection: MediaNodeConnection;
	dataProducerId: string;
	appData?: Record<string, unknown>;
}

export declare interface DataConsumer {
	// eslint-disable-next-line no-unused-vars
	on(event: 'close', listener: () => void): this;
}

export class DataConsumer extends EventEmitter {
	public closed = false;
	public router: Router;
	public connection: MediaNodeConnection;
	public id: string;
	public dataProducerId: string;
	public sctpStreamParameters: SctpStreamParameters;
	public label?: string;
	public protocol?: string;
	public appData: Record<string, unknown>;

	constructor({
		router,
		connection,
		id,
		dataProducerId,
		sctpStreamParameters,
		label,
		protocol,
		appData = {},
	}: InternalDataConsumerOptions) {
		logger.debug('constructor()');

		super();

		this.router = router;
		this.connection = connection;
		this.id = id;
		this.dataProducerId = dataProducerId;
		this.sctpStreamParameters = sctpStreamParameters;
		this.label = label;
		this.protocol = protocol;
		this.appData = appData;

		this.handleConnection();
	}

	@skipIfClosed
	public close(remoteClose = false): void {
		logger.debug('close() [id:%s, remoteClose:%s]', this.id, remoteClose);

		this.closed = true;

		if (!remoteClose) {
			this.connection.notify({
				method: 'closeDataConsumer',
				data: {
					routerId: this.router.id,
					dataConsumerId: this.id,
				}
			});
		}

		this.emit('close');
	}

	@skipIfClosed
	private handleConnection() {
		logger.debug('handleConnection()');

		this.connection.once('close', () => this.close(true));
	}
}