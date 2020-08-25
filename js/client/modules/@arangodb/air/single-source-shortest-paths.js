// //////////////////////////////////////////////////////////////////////////////
// / DISCLAIMER
// /
// /
// / Licensed under the Apache License, Version 2.0 (the "License")
// / you may not use this file except in compliance with the License.
// / You may obtain a copy of the License at
// /
// /     http://www.apache.org/licenses/LICENSE-2.0
// /
// / Unless required by applicable law or agreed to in writing, software
// / distributed under the License is distributed on an "AS IS" BASIS,
// / WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// / See the License for the specific language governing permissions and
// / limitations under the License.
// /
// / Copyright holder is ArangoDB GmbH, Cologne, Germany
// /
// / @author Heiko Kernbach
// / @author Lars Maier
// / @author Markus Pfeiffer
// / @author Copyright 2020, ArangoDB GmbH, Cologne, Germany
// //////////////////////////////////////////////////////////////////////////////

const pregel = require("@arangodb/pregel");
const examplegraphs = require("@arangodb/air/pregel-example-graphs");
const testhelpers = require("@arangodb/air/test-helpers");

const internal = require("internal");

/*


*/
exports.single_source_shortest_paths_program = single_source_shortest_paths_program;
exports.single_source_shortest_paths = single_source_shortest_paths;
exports.test = test;


function foldAccumulator(foldOp, test) {
    const inContext = function(func) {
        return [
            "let",
            [
                ["current", ["attrib-get", "value", ["current-value"]]],
                ["value", ["input-value"]]
            ],
            func
        ]
    }

    return {
        updateProgram: ["if",
            [
                ["not", ["attrib-get", "isSet", ["current-value"]]],
                ["seq",
                    ["this-set!",
                        ["dict", ["list", "isSet", true], ["list", "value", ["input-value"]]]
                    ],
                    "hot"
                ]
            ],
            [
                inContext(test),
                ["seq",
                    ["this-set!",
                        ["dict",
                            ["list", "isSet", true],
                            ["list", "value",
                                [
                                    "let",
                                    [
                                        ["current", ["attrib-get", "value", ["current-value"]]],
                                        ["value", ["input-value"]]
                                    ],
                                    inContext(foldOp)
                                ]
                            ]]
                    ],
                    "hot"
                ]
            ],
            [true, "cold"]
        ],
        clearProgram:
            ["this-set!", {"isSet": false, "value": 0}],
        getProgram:
            ["if",
                [
                    ["attrib-get", "isSet", ["current-value"]],
                    ["attrib-get", "value", ["current-value"]]
                ],
                [
                    true,
                    ["error", "accumulator undefined value"]
                ]
            ],
        setProgram:
            ["this-set!",
                ["dict", ["list", "isSet", true], ["list", "value", ["input-value"]]]
            ],
        finalizeProgram:
            ["if",
                [
                    ["attrib-get", "isSet", ["current-value"]],
                    ["attrib-get", "value", ["current-value"]]
                ],
                [true, null]
            ],
    }
}

function cmpAccumulator2(cmp) {
    return {
        updateProgram: ["if",
            [
                ["or",
                    ["not", ["attrib-get", "isSet", ["current-value"]]],
                    [cmp, ["input-value"], ["attrib-get", "value", ["current-value"]]]
                ],
                ["seq",
                    ["this-set!",
                        ["dict",
                            ["list", "isSet", true],
                            ["list", "value", ["input-value"]],
                            ["list", "sender", ["sender"]]
                        ]
                    ],
                    "hot"
                ]
            ],
            [true, "cold"]
        ],
        clearProgram: ["this-set!", {"isSet": false, "value": 0, sender: null}],
        getProgram: ["if",
            [
                ["attrib-get", "isSet", ["current-value"]],
                ["attrib-get", "value", ["current-value"]]
            ],
            [
                true,
                ["error", "accumulator undefined value"]
            ]
        ],
        setProgram: ["this-set!",
            ["dict",
                ["list", "isSet", true],
                ["list", "value", ["input-value"]],
                ["list", "sender", ["sender"]]
            ]
        ],
        finalizeProgram: ["if",
            [
                ["attrib-get", "isSet", ["current-value"]],
                ["attrib-get", "value", ["current-value"]]
            ],
            [true, null]
        ],
    }
}


function cmpAccumulator(cmp) {
    return foldAccumulator(["input-value"], [cmp, ["var-ref", "value"], ["var-ref", "current"]]);
}

const minAccumulator = cmpAccumulator("lt?");
const maxAccumulator = cmpAccumulator("gt?");

/*

  `single_source_shortest_path_program` returns an AIR program that performs a
  single-source shortest path search, currently without path reconstruction, on
  all vertices in the graph starting from `startVertex`, using the cost stored
  in `weightAttribute` on each edge, and storing the end result in resultField
  as an object containing the attribute `distance`

*/
function single_source_shortest_paths_program(
    resultField,
    startVertexId
) {
    return {
        resultField: resultField,
        maxGSS: 10000,
        vertexAccumulators: {
            distance: {
                accumulatorType: "custom",
                valueType: "slice",
                customType: "my_min",
            },
        },
        customAccumulators: {
            "my_min": minAccumulator
        },
        phases: [
            {
                name: "main",
                initProgram: [
                    "seq",
                    [
                        "if",
                        [
                            ["eq?", ["this-vertex-id"], startVertexId],
                            ["seq",
                                ["accum-set!", "distance", 0],
                                true],
                        ],
                        [true, ["seq",
                            ["accum-clear!", "distance"],
                            false]],
                    ],
                ],
                updateProgram: [
                    "seq",
                    [
                        "for-each",
                        ["edge", ["this-outbound-edges"]],
                        ["seq",
                            [
                                "send-to-accum",
                                ["attrib-ref", "to-pregel-id", ["var-ref", "edge"]],
                                "distance",
                                [
                                    "+",
                                    ["accum-ref", "distance"],
                                    1,//["attrib-ref", ["quote", "document", weightAttribute], ["var-ref", "edge"]],
                                ],
                            ],
                        ],
                    ],
                    false,
                ],
            },
        ],
    };
}

/* `single_source_shortest_path` executes the program
   returned by `single_source_shortest_path_program`
   on the graph identified by `graphName`. */
function single_source_shortest_paths(
    graphName,
    resultField,
    startVertexId
) {
    return pregel.start(
        "air",
        graphName,
        single_source_shortest_paths_program(
            resultField,
            startVertexId
        )
    );
}

function exec_test_compare_sssp_impls(graphSpec) {
    // Find the ID of a vertex to start at.
    const some_vertex = db
        ._query(`FOR d IN @@V SORT RAND() LIMIT 1 RETURN d._id`,
            {"@V": graphSpec.vname})
        .toArray()[0];

    internal.print("using " + some_vertex + " as start vertex.");

    testhelpers.wait_for_pregel(
        "Air SSSP",
        single_source_shortest_paths(
            graphSpec.name,
            "SSSP",
            some_vertex,
        ));

    testhelpers.wait_for_pregel(
        "Native SSSP",
        pregel.start("sssp", graphSpec.name, {
            source: some_vertex,
            maxGSS: 10000,
        }));

    return testhelpers.compare_pregel(db._query(`FOR d IN @@V
               FILTER NOT ( d.result == d.SSSP.distance OR ( d.SSSP.distance == NULL AND d.result > 9999999 ) )
               RETURN d`, {"@V": graphSpec.vname}));
}

function exec_test_compare_sssp(graphSpec) {
    exec_test_compare_sssp_impls(examplegraphs.create_line_graph("LineGraph100", 100, 1));
    exec_test_compare_sssp_impls(examplegraphs.create_line_graph("LineGraph1000", 1000, 9));
    exec_test_compare_sssp_impls(examplegraphs.create_line_graph("LineGraph10000", 10000, 18));

    exec_test_compare_sssp_impls(examplegraphs.create_wiki_vote_graph("WikiVote", 1));
    exec_test_compare_sssp_impls(examplegraphs.create_wiki_vote_graph("WikiVote", 9));
    exec_test_compare_sssp_impls(examplegraphs.create_wiki_vote_graph("WikiVote", 18));
}

function test() {
    exec_test_compare_sssp();
}
