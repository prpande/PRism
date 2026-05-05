using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Events;

[SuppressMessage("Design", "CA1040:Avoid empty interfaces",
    Justification = "IReviewEvent is a marker interface used as a generic constraint on IReviewEventBus to achieve compile-time type safety for event dispatch.")]
public interface IReviewEvent { }
