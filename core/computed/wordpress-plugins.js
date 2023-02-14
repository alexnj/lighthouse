/**
 * @license Copyright 2022 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import {makeComputedArtifact} from './computed-artifact.js';
import {NetworkRecords} from './network-records.js';
import {Util} from '../../shared/util.js';
import UrlUtils from '../lib/url-utils.js';

/** @typedef {Map<string, LH.Artifacts.WPPlugin>} PluginCache */

class PluginClassification {
  /**
   * @param {PluginCache} pluginCache
   * @param {string} url
   * @return {LH.Artifacts.WPPlugin | undefined}
   */
  static identifyPlugin(pluginCache, url) {
    if (!UrlUtils.isValid(url)) return;
    // We can identify a plugin only for those URLs with a valid domain attached.
    // So we further restrict from allowed URLs to (http/https).
    if (!Util.createOrReturnURL(url).protocol.startsWith('http')) return;
    if (url.indexOf('/wp-content/') < 0) return;

    const match = url.match(/\/wp-content\/(?<type>themes|plugins)\/(?<identifier>[^/]+)\//);
    const identifier = match?.groups?.identifier;
    const type = match?.groups?.type.slice(0, -1);

    if (!identifier) return;
    if (pluginCache.has(identifier)) return pluginCache.get(identifier);

    const pluginMeta = {
      name: identifier,
      type,
    };
    pluginCache.set(identifier, pluginMeta);
    return pluginMeta;
  }

  /**
   * @param {{devtoolsLog: LH.DevtoolsLog}} data
   * @param {LH.Artifacts.ComputedContext} context
   * @return {Promise<LH.Artifacts.WPPluginClassification>}
   */
  static async compute_(data, context) {
    const networkRecords = await NetworkRecords.request(data.devtoolsLog, context);
    /** @type {PluginCache} */
    const madeUpPluginCache = new Map();
    /** @type {Map<string, LH.Artifacts.WPPlugin>} */
    const pluginByUrl = new Map();
    /** @type {Map<LH.Artifacts.WPPlugin, Set<string>>} */
    const urlsByPlugin = new Map();

    for (const record of networkRecords) {
      const {url} = record;
      if (pluginByUrl.has(url)) continue;

      const plugin = PluginClassification.identifyPlugin(madeUpPluginCache, url);
      if (!plugin) continue;

      const pluginURLs = urlsByPlugin.get(plugin) || new Set();
      pluginURLs.add(url);
      urlsByPlugin.set(plugin, pluginURLs);
      pluginByUrl.set(url, plugin);
    }

    return {
      pluginByUrl,
      urlsByPlugin,
    };
  }
}

const WPPluginClassificationComputed = makeComputedArtifact(PluginClassification, ['devtoolsLog']);
export {WPPluginClassificationComputed as WPPluginClassification};
