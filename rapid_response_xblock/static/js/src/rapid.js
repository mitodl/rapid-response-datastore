(function($, _) {
  'use strict';

  // time between polls of responses API
  var POLLING_MILLIS = 3000;

  function RapidResponseAsideView(runtime, element) {
    var toggleStatusUrl = runtime.handlerUrl(element, 'toggle_block_open_status');
    var responsesUrl = runtime.handlerUrl(element, 'responses');
    var $element = $(element);

    var rapidTopLevelSel = '.rapid-response-block';
    var rapidBlockContentSel = '#rapid-response-content';
    var toggleTemplate = _.template($(element).find("#rapid-response-toggle-tmpl").text());

    var chart, chartWidth, chartHeight, colorDomain;

    // default values
    var state = {
      is_open: false,
      is_staff: false,
      responses: []
    };

    function render() {
      // Render template
      var $rapidBlockContent = $element.find(rapidBlockContentSel);
      $rapidBlockContent.html(toggleTemplate(state));
      renderD3();

      $rapidBlockContent.find('.problem-status-toggle').click(function(e) {
        $.get(toggleStatusUrl).then(
          function(newState) {
            state = Object.assign({}, state, newState);
            render();

            if (state.is_open) {
              pollForResponses();
            }
          }
        ).fail(
          function () {
            console.log("toggle data FAILED [" + toggleStatusUrl + "]");
          }
        );
      });
    }

    function initD3() {
      // This function is for creating and updating elements right after page load.

      var svg = d3.select("#rapid-response-results").append("svg");
      // TODO: These values are guesses, maybe we want to calculate browser width/height? Not sure
      chartWidth = 1000;
      chartHeight = 500;
      var marginTop = 100;
      var marginLeft = 80;
      var marginBottom = 200;
      var marginRight = 80;

      svg.attr("width", chartWidth + marginLeft + marginRight);
      svg.attr("height", chartHeight + marginTop + marginBottom);
      // The g element has a little bit of padding so the x and y axes can surround it
      chart = svg.append("g");
      chart.attr("transform", "translate(" + marginLeft + "," + marginTop + ")");

      // create x and y axes
      chart.append("g").attr("class", "xaxis").attr("transform", "translate(0," + chartHeight + ")");
      chart.append("g").attr("class", "yaxis");

      // messages we may want to overlay on the chart
      chart.append("text").attr(
        "transform", "translate(" + ((chartWidth / 2) - 150) + ", " + (chartHeight - 100) + ")"
      ).classed("message hidden", true);

      // This is a list of answer ids, kept in order that they appear in the results instead of sorted by answer id.
      // Keeping the order as they are inserted is important so that the colors don't change as new answer ids appear.
      colorDomain = [];
    }

    function makeHistogram(responses) {
      // Calculate count data for each answer id for all responses.
      // The returned array is sorted by lowercase answer id.
      var lookup = {};
      var uniqueResponses = [];
      responses.forEach(function(response) {
        if (!(response.answer_id in lookup)) {
          lookup[response.answer_id] = 1;
          uniqueResponses.push(response);
        } else {
          lookup[response.answer_id] += 1;
        }
      });
      uniqueResponses = _.sortBy(uniqueResponses, function(response) {
        return response.answer_id.toLowerCase();
      });

      return uniqueResponses.map(function(response) {
        return {
          answer_id: response.answer_id,
          answer_text: response.answer_text,
          count: lookup[response.answer_id]
        };
      });
    }

    function makeIntegerTicks(domain) {
      // Given the domain limits return 6 or so tick values, equally spaced out, all integers.
      var tickValues = [];
      var lookup = {};
      var maxCount = domain.domain()[1];
      if (!isNaN(maxCount)) {
        var numTicks = 6;
        var tickIncrement = Math.ceil(maxCount / numTicks);
        for (var tickCount = 0; tickCount < numTicks; ++tickCount) {
          var tick = tickCount * tickIncrement;
          if (!(tick in lookup)) {
            lookup[tick] = true;
            tickValues.push(tick);
          }
        }
      }
      return tickValues;
    }

    function wrapText(textSelector, barWidth, oldText) {
      // see https://bl.ocks.org/mbostock/7555321 for inspiration
      // SVG doesn't have a capability to wrap text except for foreignObject which is not supported in IE11.
      // So we have to calculate it manually
      textSelector.each(function() {
        var root = d3.select(this);

        var rootY = root.attr("y");
        var rootDy = parseFloat(root.attr("dy"));

        root.selectAll("tspan").remove();
        var words = oldText.split(/\s+/);
        var tspan = root.append("tspan").attr("x", 0).attr("y", rootY).attr("dy", rootDy + "em");

        var currentLine = 0;
        var lineHeight = 1.1;
        words.forEach(function(word) {
          if (!word) {
            return;
          }

          var oldText = tspan.text();
          tspan.text(oldText + " " + word);
          if (tspan.node().getComputedTextLength() > barWidth) {
            currentLine++;
            tspan.text(oldText + " ");
            tspan = root.append("tspan").attr("x", 0).attr("y", rootY).attr(
              "dy", ((currentLine * lineHeight) + rootDy) + "em"
            ).text(word);
          }
        });
      });
    }

    function renderD3() {
      // This function should be called whenever the response information changes.

      var message = chart.select(".message");
      var responses = state.responses;
      if (responses.length === 0) {
        message.text("No data available").classed("hidden", false);
      } else {
        message.classed("hidden", true);
      }

      // Compute responses into information suitable for a bar graph.
      var histogram = makeHistogram(responses);
      var histogramLookup = {};
      histogram.forEach(function(response) {
        histogramLookup[response.answer_id] = response;
      });

      // Add answer ids to the color domain if they don't already exist
      histogram.forEach(function(response) {
        var answerId = response.answer_id;
        if (!_.includes(colorDomain, answerId)) {
          colorDomain.push(answerId);
        }
      });

      // Create x scale to map answer ids to bar x coordinate locations. Note that
      // histogram was previously sorted in order of the lowercase answer id.
      var x = d3.scaleBand().rangeRound([0, chartWidth]).padding(0.1).domain(
        histogram.map(function(value) {
          return value.answer_id;
        })
      );
      // Create y scale to map response count to y coordinate for the top of the bar.
      var y = d3.scaleLinear().rangeRound([chartHeight, 0]).domain(
        // pick the maximum count so we know how high the bar chart should go
        [0, d3.max(histogram, function(value) {
          return value.count;
        })]
      );
      // Create a color scale similar to the x scale to provide colors for each bar
      var color = d3.scaleOrdinal(d3.schemeCategory10).domain(colorDomain);

      // The D3 data join. This matches the histogram data to the rect elements
      // (there is a __data__ attribute on each rect keeping track of this). Also tell D3 to use the answer_id to make
      // this match.
      var bars = chart.selectAll("rect").data(histogram, function(item) {
        return item.answer_id;
      });


      // Set the position and color attributes for the bars. Note that there is a transition applied
      // for the y axis for existing bars being updated.
      bars.enter()
        // Everything in between enter() and merge(bars) applies only to new bars. This creates a new rect.
        .append("rect").attr("class", "bar")
        // Set the height and y values according to the scale. This prevents weird transition behavior
        // where new bars appear to zap in out of nowhere.
        .attr("y", function(response) { return y(response.count); })
        .attr("height", function(response) {
          return chartHeight - y(response.count);
        })
        .merge(bars)
        // Now, for all bars, set the width and x values. No transition is applied for the x axis,
        // partially because of technical difficulties with the x axis labels and partially because
        // it looks strange to me
        .attr("x", function(response) { return x(response.answer_id); })
        .attr("width", x.bandwidth())
        .attr("fill", function(response) {
          return color(response.answer_id);
        })
        .transition()
        // Set a transition for the y axis for bars so that we have a slick update.
        .attr("y", function(response) { return y(response.count); })
        .attr("height", function(response) {
          return chartHeight - y(response.count);
        });

      // If the responses disappear from the API such that there is no information for the bar
      // (probably shouldn't happen),
      // remove the corresponding rect element.
      bars.exit().remove();

      // Update the X axis
      chart.select(".xaxis")
        .call(
          d3.axisBottom(x).tickFormat(function() {
            // Override tick label formatting to make it blank. To fix word wrap we need to do this manually below.
            return null;
          })
        )
        .selectAll(".tick text")
        .each(function(answerId, i, nodes) {
          var response = histogramLookup[answerId];
          var answerText = response ? response.answer_text : "";
          wrapText(d3.select(nodes[i]), x.bandwidth(), answerText);
        });


      // Update the Y axis.
      // By default it assumes a continuous scale, but we just want to show integers so we need to create the ticks
      // manually.
      var yTickValues = makeIntegerTicks(y);
      chart.select(".yaxis")
        .transition() // transition to match the bar update
        .call(
          d3.axisLeft(y).tickValues(yTickValues).tickFormat(d3.format("d"))
        );
    }

    function pollForResponses() {
      $.get(responsesUrl).then(function(newState) {
        state = Object.assign({}, state, newState);
        render();
        if (state.is_open) {
          setTimeout(pollForResponses, POLLING_MILLIS);
        }
      }).fail(function () {
        // TODO: try again?
        console.error("Error retrieving response data");
      });
    }

    $(function($) { // onLoad
      var block = $element.find(rapidTopLevelSel);
      Object.assign(state, {
        is_open: block.attr('data-open') === 'True',
        is_staff: block.attr('data-staff') === 'True'
      });
      initD3();
      render();

      if (state.is_staff) {
        pollForResponses();
      }
    });
  }

  function initializeRapidResponseAside(runtime, element) {
    return new RapidResponseAsideView(runtime, element);
  }

  window.RapidResponseAsideInit = initializeRapidResponseAside;
}($, _));
