// Enable TypeScript stack traces translation
import * as fs from "fs";
/**
 * This script launches the pwa adapter in "flat session" mode for DAP, which means
 * that all DAP traffic will be routed through a single connection (either tcp socket or stdin/out)
 * and use the sessionId field on each message to route it to the correct child session
 */
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as l10n from "@vscode/l10n";

import "reflect-metadata";

import { Readable, Writable } from "stream";
import { DebugConfiguration } from "vscode";

import { DebugType } from "./common/contributionUtils";
import { getDeferred } from "./common/promiseUtil";
import { IPseudoAttachConfiguration } from "./configuration";
import DapConnection from "./dap/connection";
import {
	IDapTransport,
	SessionIdDapTransport,
	StreamDapTransport,
} from "./dap/transport";
import { createGlobalContainer } from "./ioc";
import {
	IDebugSessionLike,
	ISessionLauncher,
	SessionManager,
} from "./sessionManager";

/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

require("source-map-support").install();

if (process.env.L10N_FSPATH_TO_BUNDLE) {
	l10n.config({ fsPath: process.env.L10N_FSPATH_TO_BUNDLE });
}

const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-js-debug-"));

class VSDebugSession implements IDebugSessionLike {
	constructor(
		public id: string,
		name: string,
		private readonly childConnection: Promise<DapConnection>,
		public readonly configuration: DebugConfiguration,
	) {
		this._name = name;
	}

	private _name: string;

	set name(newName: string) {
		this._name = newName;

		this.childConnection
			.then((conn) => conn.initializedBlocker)
			.then((conn) => conn.dap().process({ name: newName }));
	}

	get name() {
		return this._name;
	}
}

class VSSessionManager {
	private services = createGlobalContainer({ storagePath, isVsCode: false });

	private sessionManager: SessionManager<VSDebugSession>;

	private rootTransport: IDapTransport;

	constructor(inputStream: Readable, outputStream: Writable) {
		this.sessionManager = new SessionManager<VSDebugSession>(
			this.services,
			this.buildVSSessionLauncher(),
		);

		this.rootTransport = new StreamDapTransport(inputStream, outputStream);

		this.createSession(undefined, "rootSession", {
			type: DebugType.Chrome,
			name: "javascript debugger root session",
			request: "launch",
			__pendingTargetId: "",
		});
	}

	buildVSSessionLauncher(): ISessionLauncher<VSDebugSession> {
		return {
			launch: (parentSession, target, config) => {
				const childAttachConfig = { ...config, sessionId: target.id() };

				this.createSession(
					target.id(),
					target.name(),
					childAttachConfig,
				);

				// Custom message currently not part of DAP
				parentSession.connection._send({
					seq: 0,
					command: "attachedChildSession",
					type: "request",
					arguments: {
						config: childAttachConfig,
					},
				});
			},
		};
	}

	createSession(
		sessionId: string | undefined,
		name: string,
		config: IPseudoAttachConfiguration,
	) {
		const deferredConnection = getDeferred<DapConnection>();

		const vsSession = new VSDebugSession(
			sessionId || "root",
			name,
			deferredConnection.promise,
			config,
		);

		const transport = new SessionIdDapTransport(
			sessionId,
			this.rootTransport,
		);

		const newSession = config.__pendingTargetId
			? this.sessionManager.createNewChildSession(
					vsSession,
					config.__pendingTargetId,
					transport,
				)
			: this.sessionManager.createNewRootSession(vsSession, transport);

		deferredConnection.resolve(newSession.connection);

		return newSession;
	}
}

const debugServerPort = process.argv.length >= 3 ? +process.argv[2] : undefined;
if (debugServerPort !== undefined) {
	const server = net
		.createServer(async (socket) => {
			new VSSessionManager(socket, socket);
		})
		.listen(debugServerPort);

	console.log(`Listening at ${(server.address() as net.AddressInfo).port}`);
} else {
	new VSSessionManager(process.stdin, process.stdout);
}
