/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

export class RoomStateStore {
	constructor(idbStore) {
		this._roomStateStore = idbStore;
	}

	async getAllForType(type) {

	}

	async get(type, stateKey) {
        
	}

	async set(roomId, event) {
        const key = `${roomId}|${event.type}|${event.state_key}`;
        const entry = {roomId, event, key};
		return this._roomStateStore.put(entry);
	}
}
