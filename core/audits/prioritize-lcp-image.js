/**
 * @license Copyright 2020 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import {Audit} from './audit.js';
import * as i18n from '../lib/i18n/i18n.js';
import {NetworkRequest} from '../lib/network-request.js';
import {MainResource} from '../computed/main-resource.js';
import {LanternLargestContentfulPaint} from '../computed/metrics/lantern-largest-contentful-paint.js';
import {LoadSimulator} from '../computed/load-simulator.js';
import {ByteEfficiencyAudit} from './byte-efficiency/byte-efficiency-audit.js';
import {ProcessedNavigation} from '../computed/processed-navigation.js';

const UIStrings = {
  /** Title of a lighthouse audit that tells a user to preload an image in order to improve their LCP time. */
  title: 'Preload Largest Contentful Paint image',
  /** Description of a lighthouse audit that tells a user to preload an image in order to improve their LCP time.  */
  description: 'If the LCP element is dynamically added to the page, you should preload the ' +
    'image in order to improve LCP. [Learn more about preloading LCP elements](https://web.dev/optimize-lcp/#optimize-when-the-resource-is-discovered).',
};

const str_ = i18n.createIcuMessageFn(import.meta.url, UIStrings);

/**
 * @typedef {Array<{url: string, initiatorType: string}>} InitiatorPath
 */

class PrioritizeLcpImage extends Audit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'prioritize-lcp-image',
      title: str_(UIStrings.title),
      description: str_(UIStrings.description),
      supportedModes: ['navigation'],
      requiredArtifacts: ['traces', 'devtoolsLogs', 'GatherContext', 'URL', 'TraceElements'],
      scoreDisplayMode: Audit.SCORING_MODES.NUMERIC,
    };
  }

  /**
   *
   * @param {LH.Artifacts.NetworkRequest} request
   * @param {LH.Artifacts.NetworkRequest} mainResource
   * @param {Array<LH.Gatherer.Simulation.GraphNode>} initiatorPath
   * @return {boolean}
   */
  static shouldPreloadRequest(request, mainResource, initiatorPath) {
    const mainResourceDepth = mainResource.redirects ? mainResource.redirects.length : 0;

    // If it's already preloaded, no need to recommend it.
    if (request.isLinkPreload) return false;
    // It's not a request loaded over the network, don't recommend it.
    if (NetworkRequest.isNonNetworkRequest(request)) return false;
    // It's already discoverable from the main document, don't recommend it.
    if (initiatorPath.length <= mainResourceDepth) return false;
    // Finally, return whether or not it belongs to the main frame
    return request.frameId === mainResource.frameId;
  }

  /**
   * @param {LH.Gatherer.Simulation.GraphNode} graph
   * @param {string} imageUrl
   * @return {{lcpNode: LH.Gatherer.Simulation.GraphNetworkNode|undefined, path: Array<LH.Gatherer.Simulation.GraphNetworkNode>|undefined}}
   */
  static findLCPNode(graph, imageUrl) {
    let lcpNode;
    let path;
    graph.traverse((node, traversalPath) => {
      if (node.type !== 'network') return;
      if (node.record.url === imageUrl) {
        lcpNode = node;
        path =
          traversalPath.slice(1).filter(initiator => initiator.type === 'network');
      }
    });
    return {
      lcpNode,
      path,
    };
  }

  /**
   * @param {LH.Artifacts.NetworkRequest} mainResource
   * @param {LH.Gatherer.Simulation.GraphNode} graph
   * @param {string | undefined} lcpUrl
   * @return {{lcpNodeToPreload?: LH.Gatherer.Simulation.GraphNetworkNode, initiatorPath?: InitiatorPath}}
   */
  static getLCPNodeToPreload(mainResource, graph, lcpUrl) {
    if (!lcpUrl) return {};
    const {lcpNode, path} = PrioritizeLcpImage.findLCPNode(graph, lcpUrl);
    if (!lcpNode || !path) return {};

    // eslint-disable-next-line max-len
    const shouldPreload = PrioritizeLcpImage.shouldPreloadRequest(lcpNode.record, mainResource, path);
    const lcpNodeToPreload = shouldPreload ? lcpNode : undefined;

    const initiatorPath = [
      {url: lcpNode.record.url, initiatorType: lcpNode.initiatorType},
      ...path.map(n => ({url: n.record.url, initiatorType: n.initiatorType})),
    ];

    return {
      lcpNodeToPreload,
      initiatorPath,
    };
  }

  /**
   * Match the LCP event with the paint event to get the URL of the image actually painted.
   * This could differ from the `ImageElement` associated with the nodeId if e.g. the LCP
   * was a pseudo-element associated with a node containing a smaller background-image.
   * @param {LH.Trace} trace
   * @param {LH.Artifacts.ProcessedNavigation} processedNavigation
   * @return {string | undefined}
   */
  static getLcpUrl(trace, processedNavigation) {
    // Use main-frame-only LCP to match the metric value.
    const lcpEvent = processedNavigation.largestContentfulPaintEvt;
    if (!lcpEvent) return;

    const lcpImagePaintEvent = trace.traceEvents.filter(e => {
      return e.name === 'LargestImagePaint::Candidate' &&
          e.args.frame === lcpEvent.args.frame &&
          e.args.data?.DOMNodeId === lcpEvent.args.data?.nodeId &&
          e.args.data?.size === lcpEvent.args.data?.size;
    // Get last candidate, in case there was more than one.
    }).sort((a, b) => b.ts - a.ts)[0];

    return lcpImagePaintEvent?.args.data?.imageUrl;
  }

  /**
   * Computes the estimated effect of preloading the LCP image.
   * @param {LH.Artifacts.TraceElement} lcpElement
   * @param {LH.Gatherer.Simulation.GraphNetworkNode|undefined} lcpNode
   * @param {LH.Gatherer.Simulation.GraphNode} graph
   * @param {LH.Gatherer.Simulation.Simulator} simulator
   * @return {{wastedMs: number, results: Array<{node: LH.Audit.Details.NodeValue, url: string, wastedMs: number}>}}
   */
  static computeWasteWithGraph(lcpElement, lcpNode, graph, simulator) {
    if (!lcpNode) {
      return {
        wastedMs: 0,
        results: [],
      };
    }

    const modifiedGraph = graph.cloneWithRelationships();

    // Store the IDs of the LCP Node's dependencies for later
    /** @type {Set<string>} */
    const dependenciesIds = new Set();
    for (const node of lcpNode.getDependencies()) {
      dependenciesIds.add(node.id);
    }

    /** @type {LH.Gatherer.Simulation.GraphNode|null} */
    let modifiedLCPNode = null;
    /** @type {LH.Gatherer.Simulation.GraphNode|null} */
    let mainDocumentNode = null;

    for (const {node} of modifiedGraph.traverseGenerator()) {
      if (node.type !== 'network') continue;

      if (node.isMainDocument()) {
        mainDocumentNode = node;
      } else if (node.id === lcpNode.id) {
        modifiedLCPNode = node;
      }
    }

    if (!mainDocumentNode) {
      // Should always find the main document node
      throw new Error('Could not find main document node');
    }

    if (!modifiedLCPNode) {
      // Should always find the LCP node as well or else this function wouldn't have been called
      throw new Error('Could not find the LCP node');
    }

    // Preload will request the resource as soon as its discovered in the main document.
    // Reflect this change in the dependencies in our modified graph.
    modifiedLCPNode.removeAllDependencies();
    modifiedLCPNode.addDependency(mainDocumentNode);

    const simulationBeforeChanges = simulator.simulate(graph, {flexibleOrdering: true});
    const simulationAfterChanges = simulator.simulate(modifiedGraph, {flexibleOrdering: true});
    const lcpTimingsBefore = simulationBeforeChanges.nodeTimings.get(lcpNode);
    if (!lcpTimingsBefore) throw new Error('Impossible - node timings should never be undefined');
    const lcpTimingsAfter = simulationAfterChanges.nodeTimings.get(modifiedLCPNode);
    if (!lcpTimingsAfter) throw new Error('Impossible - node timings should never be undefined');
    /** @type {Map<String, LH.Gatherer.Simulation.GraphNode>} */
    const modifiedNodesById = Array.from(simulationAfterChanges.nodeTimings.keys())
      .reduce((map, node) => map.set(node.id, node), new Map());

    // Even with preload, the image can't be painted before it's even inserted into the DOM.
    // New LCP time will be the max of image download and image in DOM (endTime of its deps).
    let maxDependencyEndTime = 0;
    for (const nodeId of Array.from(dependenciesIds)) {
      const node = modifiedNodesById.get(nodeId);
      if (!node) throw new Error('Impossible - node should never be undefined');
      const timings = simulationAfterChanges.nodeTimings.get(node);
      const endTime = timings?.endTime || 0;
      maxDependencyEndTime = Math.max(maxDependencyEndTime, endTime);
    }

    const wastedMs = lcpTimingsBefore.endTime -
      Math.max(lcpTimingsAfter.endTime, maxDependencyEndTime);

    return {
      wastedMs,
      results: [{
        node: Audit.makeNodeItem(lcpElement.node),
        url: lcpNode.record.url,
        wastedMs,
      }],
    };
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @param {LH.Audit.Context} context
   * @return {Promise<LH.Audit.Product>}
   */
  static async audit(artifacts, context) {
    const gatherContext = artifacts.GatherContext;
    const trace = artifacts.traces[PrioritizeLcpImage.DEFAULT_PASS];
    const devtoolsLog = artifacts.devtoolsLogs[PrioritizeLcpImage.DEFAULT_PASS];
    const URL = artifacts.URL;
    const metricData = {trace, devtoolsLog, gatherContext, settings: context.settings, URL};
    const lcpElement = artifacts.TraceElements
      .find(element => element.traceEventType === 'largest-contentful-paint');

    if (!lcpElement || lcpElement.type !== 'image') {
      return {score: null, notApplicable: true};
    }

    const [processedNavigation, mainResource, lanternLCP, simulator] = await Promise.all([
      ProcessedNavigation.request(trace, context),
      MainResource.request({devtoolsLog, URL}, context),
      LanternLargestContentfulPaint.request(metricData, context),
      LoadSimulator.request({devtoolsLog, settings: context.settings}, context),
    ]);

    const lcpUrl = PrioritizeLcpImage.getLcpUrl(trace, processedNavigation);
    const graph = lanternLCP.pessimisticGraph;
    // eslint-disable-next-line max-len
    const {lcpNodeToPreload, initiatorPath} = PrioritizeLcpImage.getLCPNodeToPreload(mainResource, graph, lcpUrl);

    const {results, wastedMs} =
      PrioritizeLcpImage.computeWasteWithGraph(lcpElement, lcpNodeToPreload, graph, simulator);

    /** @type {LH.Audit.Details.Opportunity['headings']} */
    const headings = [
      {key: 'node', valueType: 'node', label: ''},
      {key: 'url', valueType: 'url', label: str_(i18n.UIStrings.columnURL)},
      {key: 'wastedMs', valueType: 'timespanMs', label: str_(i18n.UIStrings.columnWastedMs)},
    ];
    const details = Audit.makeOpportunityDetails(headings, results,
      {overallSavingsMs: wastedMs});

    // If LCP element was an image and had valid network records (regardless of
    // if it should be preloaded), it will be found first in the `initiatorPath`.
    // Otherwise path and length will be undefined.
    if (initiatorPath) {
      details.debugData = {
        type: 'debugdata',
        initiatorPath,
        pathLength: initiatorPath.length,
      };
    }

    return {
      score: ByteEfficiencyAudit.scoreForWastedMs(wastedMs),
      numericValue: wastedMs,
      numericUnit: 'millisecond',
      displayValue: wastedMs ? str_(i18n.UIStrings.displayValueMsSavings, {wastedMs}) : '',
      details,
    };
  }
}

export default PrioritizeLcpImage;
export {UIStrings};
