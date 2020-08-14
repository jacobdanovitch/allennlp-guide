---
title: 'Document Ranking'
description: This chapter shows a practical example of using AllenNLP to do document ranking
author: Jacob Danovitch
type: chapter
---

<textblock>

This chapter provides an example of how to perform document ranking with AllenNLP. We'll take a look
at more advanced features such as different kinds of fields, the `TimeDistributed` module, and
making our own metrics. The full code for this guide can be found
[here](https://github.com/jacobdanovitch/allenrank).

</textblock>

<exercise id="1" title="An overview on ranking">

There are several different kinds of document ranking tasks, such as ad-hoc retrieval, clickthrough rate prediction and more. 
Its simplest form, however, is the task of assigning a score to a query-document pair, which we call pointwise ranking.
This is similar to textual entailment, but instead of our labels being entailment, contradiction,
and neutral, our labels instead represent if the document is relevant to the query. This can be
presented as either binary classification, or regression with continuous relevance
scores between 0 and 1.

Because datasets for document ranking tend to be rather large, such as [MS-MARCO](https://microsoft.github.io/msmarco/) and
[ClueWeb](https://lemurproject.org/clueweb09/), we'll use the [MIMICS](https://github.com/microsoft/MIMICS) query clarification dataset 
as a lightweight alternative. Each line contains a query, a clarifying question, and a list of options presented to the user. 
This is [used in Bing](https://twitter.com/albondarenko2/status/1225802655504781312/photo/1) to help refine search results.

```json
{
    "query": "headaches",
    "question": "What do you want to know about this medical condition?",
    "options": [ "symptom", "treatment", "causes", "diagnosis", "diet" ],
    "scores": [0.05, 0.67, 0.42, 0.2, 0.0]
}
```

Each option will come with its own continuous score; our goal is to predict this score as closely as
possible, given the query, the question, and the option itself. Since there are no
training/validation/testing datasets provided by the authors, you can use [this
script](https://github.com/jacobdanovitch/allenrank/blob/master/scripts/data_split.py) to download and split the dataset:

```shell
$ python data_split.py "https://github.com/microsoft/MIMICS/blob/master/data/MIMICS-ClickExplore.tsv\?raw\=true"
```

</exercise>


<exercise id="2" title="Beyond TextFields and LabelFields">

The candidate answers provide a different challenge from what we're used to working with. Usually,
our input is a single piece of text, which we process using a `TextField`. Now, we have an input that
contains multiple texts (which can each be multiple words). In this case, we'll turn to the
`ListField`. From the [documentation](https://docs.allennlp.org/master/api/data/fields/list_field/):

> A `ListField` is a list of other fields. You would use this to represent, e.g., a list of answer
> options that are themselves `TextFields`.

Sounds perfect for our use case! We can make a couple helper functions for our dataset reader like
so:

```python
@DatasetReader.register("mimics")
class MIMICSDatasetReader(DatasetReader):

    # ...

    def _make_textfield(self, text: str):
        tokens = self.tokenizer.tokenize(text)
        if self.max_tokens:
            tokens = tokens[:self.max_tokens]
        return TextField(tokens, token_indexers=self.token_indexers)

    def _make_listfield(self, documents: List[str]):
        return ListField([self._make_textfield(d) for d in documents])
```

There are two other matters we have to handle as well. The first is how to handle the query and
question. You could make these individual text fields, but here, we're going to concatenate them to
eventually be used in a BERT model, where they'll be separated by the special `[SEP]` token.

The second is how to handle labels. While labels have normally been discrete, we now have continuous
scores. For this reason, we'll forego the use of a `LabelField`. The main utility of a `LabelField`
is to index our labels for easy conversion, but we don't have string labels here that we need
indexed. We also have multiple labels, one for each option. If we wanted to, we could use a `ListField[LabelField]` here,
but instead, we're just going to use an
[`ArrayField`](https://docs.allennlp.org/master/api/data/fields/array_field/):

> A class representing an array, which could have arbitrary dimensions. A batch of these arrays are
> padded to the max dimension length in the batch for each dimension.

This is a better fit for our dataset, and it also handles padding for us. Here's an overview of our `text_to_instance` method; for the
full dataset reader, which will iterate over the file and call `text_to_instance` for each line, see the code
[here](https://github.com/jacobdanovitch/allenrank/blob/master/allenrank/dataset_readers/mimics_reader.py).

```python

    @overrides
    def text_to_instance(
        self,
        query: str,
        question: str,
        options: List[str],
        labels: List[float] = None
    ) -> Instance:

        token_field = self._make_textfield((query, question))
        options_field = self._make_listfield(options)

        fields = { 'tokens': token_field, 'options': options_field }
        if labels:
            fields['labels'] = ArrayField(np.array(labels), padding_value=-1)

        return Instance(fields)
```


</exercise>


<exercise id="3" title="Designing our ranking model">

Let's start off by understanding our inputs and outputs. Our model is going to accept `tokens` (the
concatenation of the query and question), `options` (the `ListField[TextField]` of answer
candidates), and `labels` (the `ArrayField` containing a continuous score for each option). The
sizes have been annotated inline.

```python
@Model.register("ranker")
class DocumentRanker(Model):

    # ...

    def forward(
        self,
        tokens: Dict[str, torch,Tensor], # batch * words
        options: List[Dict[str, torch,Tensor]], # batch * num_options * words
        labels: torch.FloatTensor = None # batch * num_options
    ) -> Dict[str, torch.Tensor]:
```

Now, how do we convert our token IDs to embeddings when they're in `ListField` form?
`TextFieldEmbedders` facilitate this by accepting an extra `num_wrapping_dims` keyword argument.

```python
    def forward(
        self,
        tokens: Dict[str, torch,Tensor], # batch * words
        options: List[Dict[str, torch,Tensor]], # batch * num_options * words
        labels: torch.FloatTensor = None # batch * num_options
    ) -> Dict[str, torch.Tensor]:
        embedded_text = self._text_field_embedder(tokens, num_wrapping_dims=0)
        mask = get_text_field_mask(tokens).long()

        embedded_options = self._text_field_embedder(options, num_wrapping_dims=1)
        options_mask = get_text_field_mask(options).long()
```

This tells our embedder that we have 1 "extra" dimension relative to a normal `TextField`; where
normal would be `[Batch, Words]`, we have `[Batch, Options, Words]`. If our options were much longer
(e.g., full web pages), we might want to tokenize them into sentences, which would give us `[Batch,
Options, Sentences, Words]`. In general, a good rule of thumb for this is
`num_wrapping_dims=mask.dim()-2`, since a normal text field is 2 dimensional, and anything beyond
that is extra. Under the hood, this is implemented using the `TimeDistributed` module, which we'll
take a look at momentarily.

Next up, we need to compute a relevance score between our tokens and each of the options, which will
be used to calculate the loss and metrics. We'll make a `Registrable` for this so we can try out a
few different architectures:

```python
class RelevanceMatcher(Registrable, nn.Module):
    def __init__(
        self,
        input_dim: int
    ):
        super().__init__()
        self.dense = nn.Linear(input_dim, 1, bias=False)


    def forward(
        self,
        token_embeddings: torch.Tensor,
        option_embeddings: torch.Tensor,
        token_mask: torch.Tensor = None,
        option_mask: torch.Tensor = None
    ):
        raise NotImplementedError()
```

This outlines what each architecture should ultimately boil down to: it accepts the `tokens` and one
`option`, and computes a relevance score. Several others are included in the full codebase, but
we'll stick with a very simple one:

```python
from allennlp.modules.seq2vec_encoders.cls_pooler import ClsPooler 

@RelevanceMatcher.register('bert_cls')
class BertCLS(RelevanceMatcher):
    def __init__(
        self,
        input_dim: int,
        **kwargs
    ):
        super().__init__(input_dim=input_dim*4, **kwargs)

        # Gets the [CLS] token from BERT
        self._seq2vec_encoder = ClsPooler(embedding_dim=input_dim)

    def forward(
        self,
        token_embeddings: torch.Tensor,
        option_embeddings: torch.Tensor,
        token_mask: torch.Tensor = None,
        option_mask: torch.Tensor = None
    ):

        tokens_encoded = self._seq2vec_encoder(token_embeddings, query_mask)
        option_encoded = self._seq2vec_encoder(option_embeddings, option_mask)

        interaction_vector = torch.cat(
            [
                tokens_encoded,
                option_encoded,
                torch.abs(token_encoded-option_encoded),
                tokens_encoded*option_encoded
            ],
            dim=1,
        )
        dense_out = self.dense(interaction_vector)
        score = torch.squeeze(dense_out,1)

        return score
```

This will simply take the `[CLS]` token from both `tokens` and `option`, compute an interaction
vector (a la
[InferSent](https://research.fb.com/publications/supervised-learning-of-universal-sentence-representations-from-natural-language-inference-data/)),
and predict a dense score. There are much fancier alternatives, but this will do for now.

</exercise>


<exercise id="4" title="The TimeDistributed module">

Let's revisit the `forward` method of our `DocumentRanker`.

```python
    def forward(
        self,
        tokens: Dict[str, torch,Tensor], # batch * words
        options: List[Dict[str, torch,Tensor]], # batch * num_options * words
        labels: torch.FloatTensor = None # batch * num_options
    ) -> Dict[str, torch.Tensor]:
        embedded_text = self._text_field_embedder(tokens, num_wrapping_dims=0)
        mask = get_text_field_mask(tokens).long()

        embedded_options = self._text_field_embedder(options, num_wrapping_dims=1)
        options_mask = get_text_field_mask(options).long()
```

We have a module to score each query/document pair, but our data pairs queries with lists of documents. We need to align the query to each option for the relevance layer to work.

First, we'll use `torch.expand` to create a copy of the token embeddings for each option. Since
`torch.expand` doesn't use additional memory, this doesn't harm space complexity, but time
complexity will still increase.

```python
# [batch, num_options, words, dim]
embedded_text = embedded_text.unsqueeze(1).expand(-1, embedded_options.size(1), -1, -1)

# [batch, num_options, words]
mask = mask.unsqueeze(1).expand(-1, embedded_options.size(1), -1)
```

Now, we have an identical copy of the token embeddings for each option embedding. From here, it's
easier to stop worrying about the number of options and simply flatten everything to `[batch, words,
dim]`. Luckily, there's a module to handle this for us; the `TimeDistributed` module will flatten
each input tensor for us. We simply wrap our relevance matcher like so:

```python
self.relevance_matcher = TimeDistributed(self.relevance_matcher)
```

Now we can use our relevance matcher to score each pair.

```python
    def forward(
        self,
        tokens: Dict[str, torch,Tensor], # [batch, words]
        options: List[Dict[str, torch,Tensor]], # [batch, num_options, words]
        labels: torch.FloatTensor = None # [batch, num_options]
    ) -> Dict[str, torch.Tensor]:
        embedded_text = self._text_field_embedder(tokens)
        mask = get_text_field_mask(tokens).long()

        embedded_options = self._text_field_embedder(options, num_wrapping_dims=1)
        options_mask = get_text_field_mask(options).long()

        # [batch, num_options, words, dim]
        embedded_text = embedded_text.unsqueeze(1).expand(
            -1,
            embedded_options.size(1),
            -1,
            -1,
        )

        # [batch, num_options, words]
        mask = mask.unsqueeze(1).expand(-1, embedded_options.size(1), -1)

        scores = self._relevance_matcher(
            embedded_text,
            embedded_options,
            mask,
            options_mask,
        ).squeeze(-1)

        probs = torch.sigmoid(scores)
```

</exercise>


<exercise id="5" title="Evaluating with custom metrics">

Finally, we'll take a look at how to evaluate our model. First of all, we'll calculate the loss: 

```python
if labels is not None:
    label_mask = (labels != -1)

    # Mean-Squared Error (MSE) loss with mask
    loss = torch.pow(probs - labels, 2)
    loss = loss.masked_fill(~label_mask, 0).sum()
    loss = loss / (~label_mask).sum()
```

Since this is a regression problem, we'll use mean squared error loss, which  encourages the model to predict the score as closely as possible rather than just surpassing a certain threshold as with classification. As for the masking, remember that each instance has at _most_ 5 options; some have less. We set the padding value to be `-1` (as `0` is a valid label and shouldn't be excluded from the loss), we zero out the masked parts of the loss, take the sum, and divide by the number of non-zero elements. This gives us the correct value of the mean.

Next, we need to evaluate the model's performance. There are several metrics commonly used in document ranking, but we'll stick with **Mean Reciprocal Rank** (MRR). To understand how it's calculated, let's consider an example with the following options:

| option         | true score (rank) | predicted score (rank) |
|----------------|-------------------|------------------------|
| cookie monster | 0.65 (1)          | 0.25 (2)               |
| elmo           | 0.4 (2)           | 0.55 (1)               |
| grover         | 0.1 (3)           | 0.05 (3)               |

The correct option is the cookie monster, but our model only ranked it second. It shouldn't get a complete zero for that, but shouldn't be fully rewarded either. The reciprocal rank would give this a `1/2` for ranking the best option 2nd. More generally, the reciprocal rank score is `1` divided by the position your model ranked the correct option. If it had correctly ranked cookie monster first, its score would be `1/1 = 1`. As the name suggests, we take the mean of all these reciprocal rank scores across our dataset to find the MRR.


</exercise>